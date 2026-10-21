from pathlib import Path
import sys,json,time,hashlib,unittest,subprocess,os,threading
from unittest.mock import patch
repo=Path(sys.argv[1]).resolve()
output=Path(sys.argv[2]).resolve()
mode=sys.argv[sys.argv.index('--mode')+1] if '--mode' in sys.argv else 'source'
sys.path.insert(0,str(repo/'python/tests'))
if mode=='source': sys.path.insert(0,str(repo/'python/src'))
import coremind
from coremind import CoreMindClient
import test_mcp_stdio as subject
started=time.monotonic()
records=[]
active=False
clients=[]
output.parent.mkdir(parents=True,exist_ok=True)
if mode=='installed': assert not Path(coremind.__file__).resolve().is_relative_to(repo/'python/src'), 'installed mode loaded source SDK'
node_log=output.with_name(output.stem+'-node.jsonl')
observer=Path(__file__).with_name('diagnose-python-mcp-node.mjs')
contexts={}
current_case={}
record_lock=threading.Lock()
assert mode in {'installed','source'}
if mode=='source': assert Path(coremind.__file__).resolve().is_relative_to(repo/'python/src')
def record(stage,**fields):
    with record_lock:
        records.append({'atMs':int(time.time()*1000),'seconds':round(time.monotonic()-started,6),'stage':stage,**fields})
worker=Path(coremind.__file__).parent/'_worker/coremind-worker.mjs'
manifest_path=worker.with_name('manifest.json')
manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
sdk_files={str(f.relative_to(Path(coremind.__file__).parent)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(Path(coremind.__file__).parent.rglob('*.py'))}
record('identity',mode=mode,sdkVersion=getattr(coremind,'__version__',None),workerManifestSha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest(),manifestVersion=manifest.get('version'),manifestBundleSha256=manifest.get('bundleSha256'),gitCommit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True,encoding='utf-8').strip(),runId=os.environ.get('GITHUB_RUN_ID'),runAttempt=os.environ.get('GITHUB_RUN_ATTEMPT'),sdkFilesSha256=sdk_files,nodeVersion=subprocess.check_output(['node','--version'],text=True,encoding='utf-8').strip(),python=sys.executable,pythonVersion=sys.version,sdk=str(Path(coremind.__file__).resolve()),worker=str(worker.resolve()),workerSha256=hashlib.sha256(worker.read_bytes()).hexdigest(),fixtureSha256=hashlib.sha256(subject.FIXTURE.read_bytes()).hexdigest())
original_check=subject.McpStdioTest._check
async def check(self,**kwargs):
    global active,current_case
    active=True
    current_case=kwargs.copy()
    record('scenario.start',**kwargs)
    try:
        return await original_check(self,**kwargs)
    except BaseException as error:
        record('scenario.error',errorType=type(error).__name__,error=str(error),**kwargs)
        raise
    finally:
        record('scenario.end',**kwargs)
        active=False
        output.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
original_init=CoreMindClient.__init__
def init(self,*args,**kwargs):
    if active:
        clients.append(self)
        contexts[id(self)]={'clientId':len(clients),'case':current_case.copy()}
    context=contexts.get(id(self),{})
    handler=kwargs.get('approval_handler') if active else None
    if handler:
        def approved(event):
            record('approval.enter',**context,tool=event.get('tool'))
            decision=handler(event)
            record('approval.return',**context,tool=event.get('tool'),decision=decision)
            return decision
        kwargs['approval_handler']=approved
    return original_init(self,*args,**kwargs)
original_request=CoreMindClient._request_raw
def request(self,method,params,**kwargs):
    context=contexts.get(id(self))
    traced=context is not None and method in ('initialize','run','control','close')
    if traced: record('rpc.enter',**context,workerPid=self._process.pid if self._process else None,method=method,decision=params.get('decision'))
    result=original_request(self,method,params,**kwargs)
    if context is not None and method=='events':
        for event in result.get('events',[]):
            record('persisted.event',**context,eventType=event.get('eventType'),sequence=event.get('sequence'))
    elif traced: record('rpc.return',**context,method=method)
    return result
original_notification=CoreMindClient._handle_notification
def notification(self,message):
    params=message.get('params',{})
    context=contexts.get(id(self))
    if context is not None and message.get('method')=='event':
        event=params.get('event',{})
        record('notification',**context,eventType=event.get('type'))
    return original_notification(self,message)
original_probe=subject.probe_pids
def probe(*args,**kwargs):
    record('pidprobe.enter')
    try:
        result=original_probe(*args,**kwargs)
        record('pidprobe.result',pids=args[1],alive=result)
        return result
    finally: record('pidprobe.return')
original_finished=subject.McpStdioTest._read_finished
async def finished(self,invoke,run_id):
    events=await original_finished(self,invoke,run_id)
    record('terminal',outcome=events[-1].get('payload',{}).get('outcome'))
    if clients:
        source=Path(clients[-1]._cwd)/'service.jsonl'
        if source.is_file():
            safe=[{k:v for k,v in item.items() if k in {'type','pid','childPid','method'}} for item in subject.service_records(source)]
            record('service.records',records=safe)
    return events
original_close=CoreMindClient.close
def close(self,*args,**kwargs):
    process=self._process
    try: return original_close(self,*args,**kwargs)
    finally:
        if id(self) in contexts: record('client.closed',**contexts[id(self)],returncode=process.returncode if process else None)
original_popen=subprocess.Popen
class DiagnosticPopen(original_popen):
    def __init__(self,args,*values,**kwargs):
        if isinstance(args,(list,tuple)) and len(args)>1 and Path(str(args[1])).name=='coremind-worker.mjs' and observer.is_file():
            env=dict(kwargs.get('env') or os.environ)
            env['COREMIND_NODE_OBSERVER_LOG']=str(node_log)
            env['NODE_OPTIONS']=(env.get('NODE_OPTIONS','')+' --import='+observer.resolve().as_uri()).strip()
            kwargs['env']=env
        super().__init__(args,*values,**kwargs)
        if isinstance(args,(list,tuple)) and len(args)>1 and Path(str(args[1])).name=='coremind-worker.mjs':
            actual=Path(str(args[1])).resolve()
            record('worker.spawned',pid=self.pid,worker=str(actual),workerSha256=hashlib.sha256(actual.read_bytes()).hexdigest())
original_subprocess_run=subprocess.run
def subprocess_run(*args,**kwargs):
    try: return original_subprocess_run(*args,**kwargs)
    except subprocess.TimeoutExpired as error:
        target=Path(str(error.cmd[1])).name if isinstance(error.cmd,(list,tuple)) and len(error.cmd)>1 else 'unknown'
        output_bytes=error.stdout or b''
        try:
            value=json.loads(output_bytes)
            result_status=value.get('outcome',{}).get('status') if isinstance(value,dict) else None
            json_result=True
        except (ValueError,TypeError):
            result_status=None
            json_result=False
        record('subprocess.timeout',target=target,timeout=error.timeout,stdoutBytes=len(output_bytes),jsonResultWritten=json_result,resultStatus=result_status)
        raise
with patch.object(subprocess,'Popen',DiagnosticPopen),patch.object(subject.McpStdioTest,'_read_finished',finished),patch.object(CoreMindClient,'close',close),patch.object(subprocess,'run',subprocess_run),patch.object(subject.McpStdioTest,'_check',check),patch.object(CoreMindClient,'__init__',init),patch.object(CoreMindClient,'_request_raw',request),patch.object(CoreMindClient,'_handle_notification',notification),patch.object(subject,'probe_pids',probe):
    suite=unittest.defaultTestLoader.discover(str(repo/'python/tests'),pattern='test_*.py') if '--full' in sys.argv else unittest.defaultTestLoader.loadTestsFromTestCase(subject.McpStdioTest)
    with output.with_suffix('.log').open('w',encoding='utf-8',newline='\n') as logs:
        result=unittest.TextTestRunner(stream=logs,verbosity=2,failfast=True).run(suite)
record('summary',testsRun=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped),success=result.wasSuccessful())
output.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
print('diagnostic:',output)
sys.exit(0 if result.wasSuccessful() else 1)

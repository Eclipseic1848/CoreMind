import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { rewriteDocumentationLink } from "../../scripts/docs-link-policy.mjs";

const repository = "https://github.com/Eclipseic1848/CoreMind";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  title: "CoreMind",
  description: "配置驱动、质量内建的智能体开发框架",
  base: "/CoreMind/",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [/^\.\.\//],
  markdown: {
    config(markdown) {
      const originalLinkOpen = markdown.renderer.rules.link_open;
      markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
        const hrefIndex = tokens[index].attrIndex("href");
        if (hrefIndex >= 0) {
          const href = tokens[index].attrs?.[hrefIndex]?.[1] ?? "";
          tokens[index].attrSet(
            "href",
            rewriteDocumentationLink(href, environment.relativePath ?? "", repositoryRoot),
          );
        }
        return originalLinkOpen
          ? originalLinkOpen(tokens, index, options, environment, self)
          : self.renderToken(tokens, index, options);
      };
    },
  },
  vue: {
    template: {
      compilerOptions: {
        delimiters: ["<%", "%>"],
      },
    },
  },
  locales: {
    root: { label: "简体中文", lang: "zh-CN", themeConfig: zhTheme() },
    en: { label: "English", lang: "en-US", link: "/en/", themeConfig: enTheme() },
  },
  themeConfig: {
    logo: "/logo.svg",
    socialLinks: [{ icon: "github", link: repository }],
    search: { provider: "local" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © CoreMind Contributors",
    },
  },
});

function zhTheme() {
  return {
    nav: [
      { text: "快速开始", link: "/guide/01-quickstart" },
      { text: "开发指南", link: "/guide/02-configuration" },
      { text: "功能模块", link: "/modules/README.zh-CN" },
      { text: "供应商", link: "/providers/README.zh-CN" },
      { text: "发布验收", link: "/release/RC-ACCEPTANCE.zh-CN" },
      { text: "路线图", link: "/roadmap.zh-CN" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "入门",
          items: [
            { text: "快速开始", link: "/guide/01-quickstart" },
            { text: "配置", link: "/guide/02-configuration" },
            { text: "Skills", link: "/guide/03-skills" },
            { text: "质量保障", link: "/guide/04-quality" },
            { text: "CLI 使用", link: "/guide/05-cli-usage" },
          ],
        },
      ],
    },
    outline: { label: "本页目录", level: [2, 3] },
    docFooter: { prev: "上一页", next: "下一页" },
  };
}

function enTheme() {
  return {
    nav: [
      { text: "Quick Start", link: "/en/guide/01-quickstart" },
      { text: "Guides", link: "/en/guide/02-configuration" },
      { text: "Modules", link: "/modules/README.en" },
      { text: "Providers", link: "/providers/README.en" },
      { text: "Release acceptance", link: "/release/RC-ACCEPTANCE.en" },
      { text: "Roadmap", link: "/roadmap.en" },
    ],
    sidebar: {
      "/en/guide/": [
        {
          text: "Get started",
          items: [
            { text: "Quick Start", link: "/en/guide/01-quickstart" },
            { text: "Configuration", link: "/en/guide/02-configuration" },
            { text: "Skills", link: "/en/guide/03-skills" },
            { text: "Quality", link: "/en/guide/04-quality" },
            { text: "CLI", link: "/en/guide/05-cli-usage" },
          ],
        },
      ],
    },
    outline: { label: "On this page", level: [2, 3] },
    docFooter: { prev: "Previous", next: "Next" },
  };
}

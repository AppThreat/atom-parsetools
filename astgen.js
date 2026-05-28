#!/usr/bin/env node

import { join, dirname, relative, resolve, basename } from "path";
import { fileURLToPath } from "url";
import { parse } from "@babel/parser";
import { parse as parseHermes } from "hermes-parser";
import tsc from "typescript";
import { tmpdir } from "os";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync
} from "fs";
import { getAllFiles } from "@appthreat/atom-common";

const ASTGEN_VERSION = "4.0.0";

const HELP_TEXT = `Options:
  -i, --src      Source directory                                 [default: "."]
  -o, --output   Output directory for generated AST JSON files
                                                            [default: "ast_out"]
  -t, --type     Project type. Default auto-detect
  -r, --recurse  Recurse mode suitable for mono-repos  [boolean] [default: true]
      --tsTypes  Generate type mappings using the TypeScript Compiler API
                                                       [boolean] [default: true]
      --version  Show version number                                   [boolean]
  -h, --help     Show help                                             [boolean]`;

const CLI_OPTIONS = {
  src: { alias: "i", default: ".", type: "string" },
  output: { alias: "o", default: "ast_out", type: "string" },
  type: { alias: "t", type: "string" },
  recurse: { alias: "r", default: true, type: "boolean" },
  tsTypes: { default: true, type: "boolean" }
};

const CLI_ALIASES = Object.fromEntries(
  Object.entries(CLI_OPTIONS)
    .filter(([, option]) => option.alias)
    .map(([name, option]) => [option.alias, name])
);

const normalizeOptionName = (name) =>
  name.replace(/-([a-z])/g, (_, character) => character.toUpperCase());

const isOptionToken = (value) => value?.startsWith("-") && value !== "-";

const parseBooleanValue = (name, value) => {
  if (value === undefined) {
    return true;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value for --${name}: ${value}`);
};

const setParsedOption = (args, name, value) => {
  const normalizedName = normalizeOptionName(name);
  const option = CLI_OPTIONS[normalizedName];
  if (!option) {
    args[normalizedName] = value ?? true;
    return;
  }
  args[normalizedName] =
    option.type === "boolean"
      ? parseBooleanValue(normalizedName, value)
      : value;
};

const parseLongOption = (args, rawArgs, index) => {
  const token = rawArgs[index];
  const noPrefix = token.startsWith("--no-");
  const optionToken = token.slice(noPrefix ? 5 : 2);
  const equalsIndex = optionToken.indexOf("=");
  const rawName =
    equalsIndex === -1 ? optionToken : optionToken.slice(0, equalsIndex);
  const name = normalizeOptionName(rawName);
  const inlineValue =
    equalsIndex === -1 ? undefined : optionToken.slice(equalsIndex + 1);
  const option = CLI_OPTIONS[name];

  if (noPrefix) {
    setParsedOption(args, name, false);
    return index;
  }
  if (!option) {
    if (inlineValue !== undefined) {
      setParsedOption(args, name, inlineValue);
    } else if (
      rawArgs[index + 1] !== undefined &&
      !isOptionToken(rawArgs[index + 1])
    ) {
      setParsedOption(args, name, rawArgs[index + 1]);
      return index + 1;
    } else {
      setParsedOption(args, name, true);
    }
    return index;
  }
  if (option?.type === "boolean") {
    if (inlineValue !== undefined) {
      setParsedOption(args, name, inlineValue);
    } else if (
      rawArgs[index + 1] !== undefined &&
      !isOptionToken(rawArgs[index + 1])
    ) {
      setParsedOption(args, name, rawArgs[index + 1]);
      return index + 1;
    } else {
      setParsedOption(args, name, true);
    }
    return index;
  }
  if (inlineValue !== undefined) {
    setParsedOption(args, name, inlineValue);
    return index;
  }
  if (rawArgs[index + 1] === undefined || isOptionToken(rawArgs[index + 1])) {
    throw new Error(`Missing value for --${rawName}`);
  }
  setParsedOption(args, name, rawArgs[index + 1]);
  return index + 1;
};

const parseShortOption = (args, rawArgs, index) => {
  const token = rawArgs[index];
  const equalsIndex = token.indexOf("=");
  const letters = token.slice(1, equalsIndex === -1 ? undefined : equalsIndex);
  const inlineValue =
    equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

  for (let letterIndex = 0; letterIndex < letters.length; letterIndex++) {
    const letter = letters[letterIndex];
    const name = CLI_ALIASES[letter] ?? letter;
    const option = CLI_OPTIONS[name];
    const remainingLetters = letters.slice(letterIndex + 1);

    if (letter === "h") {
      args.help = true;
      continue;
    }
    if (!option) {
      if (remainingLetters) {
        setParsedOption(args, name, remainingLetters);
        return index;
      }
      if (inlineValue !== undefined) {
        setParsedOption(args, name, inlineValue);
        return index;
      }
      if (
        rawArgs[index + 1] !== undefined &&
        !isOptionToken(rawArgs[index + 1])
      ) {
        setParsedOption(args, name, rawArgs[index + 1]);
        return index + 1;
      }
      setParsedOption(args, name, true);
      continue;
    }
    if (option?.type === "boolean") {
      if (inlineValue !== undefined) {
        setParsedOption(args, name, inlineValue);
      } else if (
        !remainingLetters &&
        rawArgs[index + 1] !== undefined &&
        !isOptionToken(rawArgs[index + 1])
      ) {
        setParsedOption(args, name, rawArgs[index + 1]);
        return index + 1;
      } else {
        setParsedOption(args, name, true);
      }
      continue;
    }
    if (remainingLetters) {
      setParsedOption(args, name, remainingLetters);
      return index;
    }
    if (inlineValue !== undefined) {
      setParsedOption(args, name, inlineValue);
      return index;
    }
    if (rawArgs[index + 1] === undefined || isOptionToken(rawArgs[index + 1])) {
      throw new Error(`Missing value for -${letter}`);
    }
    setParsedOption(args, name, rawArgs[index + 1]);
    return index + 1;
  }
  return index;
};

const parseCliArgs = (argvs) => {
  const rawArgs = argvs.slice(2);
  const args = Object.fromEntries(
    Object.entries(CLI_OPTIONS)
      .filter(([, option]) => option.default !== undefined)
      .map(([name, option]) => [name, option.default])
  );
  args._ = [];

  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index];
    if (token === "--") {
      args._.push(...rawArgs.slice(index + 1));
      break;
    }
    if (token === "--help") {
      args.help = true;
      continue;
    }
    if (token === "--version") {
      args.version = true;
      continue;
    }
    if (token.startsWith("--")) {
      index = parseLongOption(args, rawArgs, index);
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      index = parseShortOption(args, rawArgs, index);
      continue;
    }
    args._.push(token);
  }
  return args;
};

const babelSyntaxPlugins = [
  "optionalChaining",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "decorators-legacy",
  "exportDefaultFrom",
  "doExpressions",
  "numericSeparator",
  "dynamicImport",
  "importAttributes",
  "explicitResourceManagement",
  "topLevelAwait"
];

const isNonJsxTypeScriptFile = (file) =>
  /(?:^|\/).*\.(?:d\.)?(?:ts|mts|cts)$/i.test(file);

const isJsLikeNonJsxFile = (file) => /(?:^|\/).*\.(?:js|cjs|mjs)$/i.test(file);

const shouldEnableJsxSyntax = (file) => !isNonJsxTypeScriptFile(file);

const makeTypescriptPlugin = (
  file,
  { disallowAmbiguousJSXLike = isNonJsxTypeScriptFile(file) } = {}
) => [
  "typescript",
  {
    dts:
      file.endsWith(".d.ts") ||
      file.endsWith(".d.mts") ||
      file.endsWith(".d.cts"),
    disallowAmbiguousJSXLike
  }
];

const getBabelPluginName = (plugin) =>
  Array.isArray(plugin) ? plugin[0] : plugin;

const mergeBabelPlugins = (...pluginGroups) => {
  const merged = [];
  const seen = new Set();
  for (const plugins of pluginGroups) {
    for (const plugin of plugins || []) {
      const pluginName = getBabelPluginName(plugin);
      if (!seen.has(pluginName)) {
        seen.add(pluginName);
        merged.push(plugin);
      }
    }
  }
  return merged;
};

const makeBabelOptions = (
  baseOptions,
  file,
  extraPlugins = [],
  {
    enableJsxSyntax = shouldEnableJsxSyntax(file),
    disallowAmbiguousJSXLike
  } = {}
) => ({
  ...baseOptions,
  plugins: mergeBabelPlugins(
    baseOptions.plugins,
    extraPlugins,
    babelSyntaxPlugins,
    enableJsxSyntax ? ["jsx"] : [],
    (baseOptions.plugins || []).some(
      (plugin) => getBabelPluginName(plugin) === "flow"
    )
      ? []
      : [makeTypescriptPlugin(file, { disallowAmbiguousJSXLike })]
  )
});

const shouldTryNonJsxTypescriptFallback = (file, projectType) =>
  projectType !== "flow" &&
  !/\.tsx$/i.test(file) &&
  !/\.jsx$/i.test(file) &&
  (isNonJsxTypeScriptFile(file) || isJsLikeNonJsxFile(file));

const babelParserOptions = {
  sourceType: "unambiguous",
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowNewTargetOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowUndeclaredExports: true,
  errorRecovery: true
};

const babelFlowParserOptions = {
  sourceType: "unambiguous",
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowNewTargetOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowUndeclaredExports: true,
  errorRecovery: true,
  plugins: [
    "optionalChaining",
    "classProperties",
    "decorators-legacy",
    "exportDefaultFrom",
    "doExpressions",
    "numericSeparator",
    "dynamicImport",
    "jsx",
    ["flow", { all: true, enums: true }]
  ]
};

const babelSafeParserOptions = {
  sourceType: "module",
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  errorRecovery: true
};

const babelSafeFlowParserOptions = {
  sourceType: "module",
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  errorRecovery: true,
  plugins: [
    "optionalChaining",
    "classProperties",
    "decorators-legacy",
    "exportDefaultFrom",
    "doExpressions",
    "numericSeparator",
    "dynamicImport",
    "flow"
  ]
};

const shouldIncludeNodeModulesBundles =
  process.env?.ASTGEN_INCLUDE_NODE_MODULES_BUNDLES === "true" ||
  (process.env?.ASTGEN_IGNORE_DIRS &&
    process.env.ASTGEN_IGNORE_DIRS.length > 0 &&
    !process.env.ASTGEN_IGNORE_DIRS.toLowerCase().includes("node_modules"));

/**
 * Return paths to all (j|tsx?) files.
 * Optionally includes specific bundled files from node_modules if:
 * 1. ASTGEN_INCLUDE_NODE_MODULES_BUNDLES is "true", OR
 * 2. ASTGEN_IGNORE_DIRS is non-empty and doesn't include "node_modules"
 */
const getAllSrcJSAndTSFiles = (src) => {
  const filePattern =
    "\\.(js|jsx|cjs|mjs|ts|tsx|mts|cts|vue|svelte|xsjs|xsjslib|ejs)$";
  const bundledNodeModulesPattern =
    "node_modules[\\\\/].*[\\\\/](?:.*\\.)?(bundle|dist|index|min|app)\\.(js|cjs|mjs)$";

  // Step 1: Collect all JS/TS files EXCLUDING node_modules
  const allFilesPromise = Promise.resolve(
    getAllFiles(
      src,
      undefined,
      undefined,
      undefined,
      new RegExp(filePattern),
      true // ignore node_modules
    )
  );
  let bundledFilesPromise = Promise.resolve([]);
  if (shouldIncludeNodeModulesBundles) {
    bundledFilesPromise = Promise.resolve(
      getAllFiles(
        src,
        undefined,
        undefined,
        undefined,
        new RegExp(bundledNodeModulesPattern),
        false // DO NOT ignore node_modules
      )
    );
  }
  // Step 2: Combine both lists
  return Promise.all([allFilesPromise, bundledFilesPromise]).then(
    ([allFiles, bundledFiles]) =>
      [...new Set([...allFiles, ...bundledFiles])].sort()
  );
};

/**
 * Convert a single JS/TS file to AST
 */
const fileToJsAst = (file, projectType, tsInstance) => {
  if (file.endsWith(".vue") || file.endsWith(".svelte")) {
    return toVueAst(file, tsInstance);
  }
  if (file.endsWith(".ejs")) {
    return toEjsAst(file);
  }
  return codeToJsAst(file, readFileSync(file, "utf-8"), projectType);
};

/**
 * Convert a single JS/TS code snippet to AST
 */
const codeToJsAst = (file, code, projectType) => {
  const isJs = /\.(js|jsx|cjs|mjs)$/.test(file);
  if (isJs && projectType === "flow") {
    try {
      return parseHermes(code, {
        sourceType: "unambiguous",
        babel: true,
        allowReturnOutsideFunction: true,
        flow: "all",
        sourceFilename: file,
        tokens: true
      });
    } catch (err) {
      // Ignore
    }
  }
  // If user explicitly said 'flow', we try Babel-Flow first, then Babel-Standard.
  // Otherwise, we try Babel-Standard (TS/ESNext) first, then Babel-Flow and finally hermes.
  let primaryBabelOptions = babelParserOptions;
  let secondaryBabelOptions = babelFlowParserOptions;
  if (projectType === "flow") {
    primaryBabelOptions = babelFlowParserOptions;
    secondaryBabelOptions = babelParserOptions;
  }
  const primaryOptions = makeBabelOptions(primaryBabelOptions, file);
  const secondaryOptions = makeBabelOptions(secondaryBabelOptions, file);
  const safeOptions = makeBabelOptions(babelSafeParserOptions, file);
  const nonJsxTypeScriptFallbackOptions = shouldTryNonJsxTypescriptFallback(
    file,
    projectType
  )
    ? makeBabelOptions(primaryBabelOptions, file, [], {
        enableJsxSyntax: false,
        disallowAmbiguousJSXLike: true
      })
    : undefined;
  try {
    return parse(code, primaryOptions);
  } catch (errPrimary) {
    if (nonJsxTypeScriptFallbackOptions) {
      try {
        return parse(code, nonJsxTypeScriptFallbackOptions);
      } catch {
        // Fall through to the broader parser fallback chain below.
      }
    }
    try {
      return parse(code, secondaryOptions);
    } catch (errSecondary) {
      try {
        return parse(code, safeOptions);
      } catch (errSafe) {
        try {
          return parse(code, babelSafeFlowParserOptions);
        } catch (errSafeFlow) {
          return parseHermes(code, {
            sourceType: "unambiguous",
            babel: true,
            allowReturnOutsideFunction: true,
            flow: "all",
            sourceFilename: file,
            tokens: true
          });
        }
      }
    }
  }
};

const vueCleaningRegex = /<\/*script.*>|<style[\s\S]*style>|<\/*br>/gi;
const vueTemplateRegex = /(<template.*>)([\s\S]*)(<\/template>)/gi;
const vueCommentRegex = /<!--[\s\S]*?-->/gi;
const vueBindRegex = /(:\[)([\s\S]*?)(\])/gi;
const vuePropRegex = /\s([.:@])([a-zA-Z]*?=)/gi;
const vueOpenImgTag = /(<img)((?!>)[\s\S]+?)( [^/]>)/gi;
const vueScriptTagRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

const VUE_COMPILER_MACRO_SHIMS = `
declare function defineProps<T = any>(): T;
declare function defineEmits<T = any>(): T;
declare function defineExpose<T = any>(value?: T): void;
declare function defineSlots<T = any>(): T;
declare function defineModel<T = any>(
  options?: { required?: boolean; default?: T }
): import("vue").Ref<T>;
declare function defineModel<T = any>(
  name: string,
  options?: { required?: boolean; default?: T }
): import("vue").Ref<T>;
declare function withDefaults<T, D>(props: T, defaults: D): T & D;

declare module "vue" {
  export type Ref<T = any> = { value: T };
  export type ComputedRef<T = any> = { readonly value: T };
  export type InjectionKey<T> = symbol & { __type?: T };
  export function ref<T>(value: T): Ref<T>;
  export function ref<T = any>(): Ref<T | undefined>;
  export function shallowRef<T>(value: T): Ref<T>;
  export function computed<T>(getter: () => T): ComputedRef<T>;
  export function inject<T>(key: any, defaultValue?: T): T;
  export function provide<T>(key: any, value: T): void;
  export function watch(...args: any[]): void;
  export function watchEffect(effect: () => void): void;
  export function onMounted(cb: () => void): void;
  export function onUnmounted(cb: () => void): void;
}
`;

const maskNonNewlineChars = (value) => value.replace(/[^\r\n]/g, " ");

const createVueVirtualTypeSource = (code) => {
  const output = maskNonNewlineChars(code).split("");
  let hasScriptContent = false;
  let scriptMatch;
  vueScriptTagRegex.lastIndex = 0;
  while ((scriptMatch = vueScriptTagRegex.exec(code)) !== null) {
    const fullMatch = scriptMatch[0];
    const scriptContent = scriptMatch[1] || "";
    const contentStart = scriptMatch.index + fullMatch.indexOf(scriptContent);
    if (scriptContent.trim().length > 0) {
      hasScriptContent = true;
    }
    for (let index = 0; index < scriptContent.length; index++) {
      output[contentStart + index] = scriptContent[index];
    }
  }
  return {
    source: output.join(""),
    hasScriptContent
  };
};

const collectVueTypesWithVirtualProgram = (file, virtualSource) => {
  const tempDir = mkdtempSync(join(tmpdir(), "atom-parsetools-vue-"));
  const virtualFile = join(tempDir, `${basename(file)}.ts`);
  const shimFile = join(tempDir, "vue-shims.d.ts");
  try {
    writeFileSync(virtualFile, virtualSource, "utf8");
    writeFileSync(shimFile, VUE_COMPILER_MACRO_SHIMS, "utf8");
    const virtualTs = createTsc([virtualFile, shimFile], tempDir);
    const sourceFile = virtualTs?.program?.getSourceFile(virtualFile);
    if (!virtualTs || !sourceFile) {
      return new Map();
    }
    return virtualTs.collectTypes(sourceFile);
  } catch {
    return new Map();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const TSC_FLAGS =
  tsc.TypeFormatFlags.NoTruncation |
  tsc.TypeFormatFlags.InTypeAlias |
  tsc.TypeFormatFlags.WriteArrayAsGenericType |
  tsc.TypeFormatFlags.GenerateNamesForShadowedTypeParams |
  tsc.TypeFormatFlags.WriteTypeArgumentsOfSignature |
  tsc.TypeFormatFlags.UseFullyQualifiedType |
  tsc.TypeFormatFlags.NoTypeReduction;

/**
 * Convert a single vue file to AST.
 * When `tsInstance` is present also collect type inference from TSC and return both AST & types.
 */
const toVueAst = (file, tsInstance) => {
  const code = readFileSync(file, "utf-8");
  const cleanedCode = code
    .replace(vueCommentRegex, function (match) {
      return match.replaceAll(/\S/g, " ");
    })
    .replace(vueCleaningRegex, function (match) {
      return match.replaceAll(/\S/g, " ").substring(1) + ";";
    })
    .replace(vueBindRegex, function (match, grA, grB, grC) {
      return grA.replaceAll(/\S/g, " ") + grB + grC.replaceAll(/\S/g, " ");
    })
    .replace(vuePropRegex, function (match, grA, grB) {
      return " " + grA.replace(/[.:@]/g, " ") + grB.replaceAll(".", "-");
    })
    .replace(vueOpenImgTag, function (match, grA, grB, grC) {
      return grA + grB + grC.replace(" >", "/>");
    })
    .replace(vueTemplateRegex, function (match, grA, grB, grC) {
      return grA + grB.replaceAll("{{", "{ ").replaceAll("}}", " }") + grC;
    });
  const ast = codeToJsAst(file, cleanedCode, "ts");
  let seenTypes;
  if (tsInstance?.program) {
    try {
      const tsSrc = tsInstance.program.getSourceFile(file);
      if (tsSrc) {
        seenTypes = tsInstance.collectTypes(tsSrc);
      }
    } catch {
      // Ignore and continue with virtual source fallback below.
    }
  }

  if (!seenTypes || seenTypes.size === 0) {
    const virtualSource = createVueVirtualTypeSource(code);
    if (virtualSource.hasScriptContent) {
      seenTypes = collectVueTypesWithVirtualProgram(file, virtualSource.source);
    }
  }

  return seenTypes && seenTypes.size > 0 ? { ast, seenTypes } : ast;
};

/**
 * Convert a single EJS file to AST.
 */
const toEjsAst = (file) => {
  const originalCode = readFileSync(file, "utf-8");
  let arr = originalCode.split("");
  const scriptRegex = /(<script>)([\s\S]*?)(<\/script>)/gi;
  let match;
  while ((match = scriptRegex.exec(originalCode)) !== null) {
    const openStart = match.index;
    const openLen = match[1].length;
    arr[openStart] = "<";
    arr[openStart + 1] = "%";
    for (let i = 2; i < openLen; i++) arr[openStart + i] = " ";
    const closeStart = match.index + match[0].length - match[3].length;
    const closeLen = match[3].length;
    arr[closeStart] = "%";
    arr[closeStart + 1] = ">";
    for (let i = 2; i < closeLen; i++) arr[closeStart + i] = " ";
    const content = match[2];
    const contentOffset = openStart + openLen;
    const innerRegex = /(<%[=\-_#]?)([\s\S]*?)([-_#]?%>)/g;
    let innerMatch;
    while ((innerMatch = innerRegex.exec(content)) !== null) {
      const innerAbsStart = contentOffset + innerMatch.index;
      if (innerMatch[1] === "<%" && innerMatch[3] === "-%>") {
        for (let k = 0; k < innerMatch[0].length; k++)
          arr[innerAbsStart + k] = " ";
      } else {
        for (let k = 0; k < innerMatch[1].length; k++)
          arr[innerAbsStart + k] = " ";
        const endDelimStart =
          innerAbsStart + innerMatch[0].length - innerMatch[3].length;
        for (let k = 0; k < innerMatch[3].length; k++)
          arr[endDelimStart + k] = " ";
      }
    }
  }

  const codeWithoutScriptTag = arr.join("");
  const out = new Array(codeWithoutScriptTag.length).fill(" ");
  for (let i = 0; i < codeWithoutScriptTag.length; i++) {
    const c = codeWithoutScriptTag[i];
    if (c === "\n" || c === "\r") out[i] = c;
  }

  const tagRegex = /(<%[=\-_#]?)([\s\S]*?)([-_#]?%>)/g;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(codeWithoutScriptTag)) !== null) {
    const [fullMatch, openTag, content, closeTag] = tagMatch;
    if (openTag === "<%#" || content.trim().startsWith("include ")) continue;

    let processedContent = content.trim();
    let isTransformed = false;
    if (processedContent === "end") {
      processedContent = "}";
      isTransformed = true;
    } else if (processedContent === "else") {
      processedContent = "} else {";
      isTransformed = true;
    } else if (processedContent.startsWith("else if")) {
      let sub = processedContent.substring(4).trim();
      const controlMatch = sub.match(/^(if)\s+(?!\()(.+)$/);
      if (controlMatch) {
        sub = `if (${controlMatch[2]})`;
      }
      processedContent = `} else ${sub} {`;
      isTransformed = true;
    } else {
      const controlMatch = processedContent.match(
        /^(if|while|for)\s+(?!\()(.+)$/
      );
      if (controlMatch) {
        const keyword = controlMatch[1];
        const condition = controlMatch[2];
        processedContent = `${keyword} (${condition})`;
        isTransformed = true;
      }
      if (
        /^(if|while|for|try|switch|catch)/.test(processedContent) &&
        !processedContent.endsWith("{") &&
        !processedContent.endsWith("}") &&
        !processedContent.endsWith(";")
      ) {
        processedContent += " {";
        isTransformed = true;
      }
    }
    if (isTransformed) {
      const startIndex = tagMatch.index;
      const maxLen = fullMatch.length;
      const needsSemi =
        processedContent.length > 0 &&
        !processedContent.endsWith("{") &&
        !processedContent.endsWith("}") &&
        !processedContent.endsWith(";");
      if (needsSemi) processedContent += ";";

      for (let k = 0; k < processedContent.length; k++) {
        if (k < maxLen) {
          out[startIndex + k] = processedContent[k];
        }
      }
    } else {
      const startIndex = tagMatch.index + openTag.length;
      const endIndex = tagMatch.index + fullMatch.length - closeTag.length;

      for (let k = startIndex; k < endIndex; k++) {
        out[k] = codeWithoutScriptTag[k];
      }

      const needsSemi =
        processedContent.length > 0 &&
        !processedContent.endsWith("{") &&
        !processedContent.endsWith("}") &&
        !processedContent.endsWith(";");

      if (needsSemi) {
        out[endIndex] = ";";
      }
    }
  }

  return codeToJsAst(file, out.join(""), "ts");
};

const DEFAULT_TSC_OPTIONS = {
  target: tsc.ScriptTarget.ES2022,
  module: tsc.ModuleKind.CommonJS,
  moduleResolution: tsc.ModuleResolutionKind.Node10,
  allowImportingTsExtensions: false,
  allowArbitraryExtensions: false,
  allowSyntheticDefaultImports: true,
  allowUmdGlobalAccess: true,
  allowJs: true,
  checkJs: true,
  allowUnreachableCode: true,
  allowUnusedLabels: true,
  alwaysStrict: false,
  emitDecoratorMetadata: true,
  exactOptionalPropertyTypes: true,
  experimentalDecorators: true,
  ignoreDeprecations: "6.0",
  noStrictGenericChecks: true,
  noUncheckedIndexedAccess: false,
  noPropertyAccessFromIndexSignature: false,
  noEmit: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  jsx: tsc.JsxEmit.Preserve,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]
};

const readJsonFileIfExists = (file) => {
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const findNearestPackageJson = (src) => {
  let currentDir = resolve(src);
  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
};

const detectDefaultTscOptions = (srcFiles, src) => {
  const packageJson = readJsonFileIfExists(findNearestPackageJson(src));
  const usesNodeNextModuleResolution =
    packageJson?.type === "module" ||
    Boolean(packageJson?.exports) ||
    Boolean(packageJson?.imports) ||
    srcFiles.some((file) => /\.(?:mts|cts)$/.test(file));

  if (!usesNodeNextModuleResolution) {
    return DEFAULT_TSC_OPTIONS;
  }

  return {
    ...DEFAULT_TSC_OPTIONS,
    module: tsc.ModuleKind.NodeNext,
    moduleResolution: tsc.ModuleResolutionKind.NodeNext,
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true
  };
};

const hasExplicitTsCompilerOption = (config, optionName) =>
  Object.prototype.hasOwnProperty.call(
    config?.compilerOptions ?? {},
    optionName
  );

const normalizeImportedTypeSpecifier = (specifier, currentFileName) => {
  let normalizedSpecifier = String(specifier).replaceAll("\\", "/");
  const normalizedCurrentFileName = currentFileName?.replaceAll("\\", "/");

  if (normalizedSpecifier.startsWith("file://")) {
    try {
      normalizedSpecifier = fileURLToPath(normalizedSpecifier).replaceAll(
        "\\",
        "/"
      );
    } catch {
      // ignore malformed file URLs and leave the original specifier intact
    }
  }

  if (normalizedCurrentFileName && normalizedSpecifier.startsWith("/")) {
    const relativeSpecifier = relative(
      dirname(normalizedCurrentFileName),
      normalizedSpecifier
    ).replaceAll("\\", "/");
    normalizedSpecifier = relativeSpecifier.startsWith(".")
      ? relativeSpecifier
      : `./${relativeSpecifier}`;
  }

  return normalizedSpecifier.replace(
    /(\.d)?\.(tsx?|jsx?|mts|cts|mjs|cjs)$/,
    ""
  );
};

const normalizeTypeString = (typeStr, context) => {
  if (!typeStr || typeof typeStr !== "string") {
    return typeStr;
  }
  const currentFileName = context?.getSourceFile?.()?.fileName;
  return typeStr.replace(
    /import\("([^"]+)"(?:,\s*{\s*with:\s*{\s*"resolution-mode":\s*"import"\s*}\s*})?\)/g,
    (_, specifier) =>
      `import("${normalizeImportedTypeSpecifier(specifier, currentFileName)}")`
  );
};

const findTsConfig = (src) => {
  const searchRoot = resolve(src);
  return (
    tsc.findConfigFile(searchRoot, tsc.sys.fileExists, "tsconfig.json") ||
    tsc.findConfigFile(searchRoot, tsc.sys.fileExists, "jsconfig.json")
  );
};

const createTscProgramConfig = (srcFiles, src) => {
  const detectedDefaultOptions = detectDefaultTscOptions(srcFiles, src);
  const configPath = findTsConfig(src);
  if (!configPath) {
    return {
      rootNames: srcFiles,
      options: detectedDefaultOptions
    };
  }

  const configFile = tsc.readConfigFile(configPath, tsc.sys.readFile);
  if (configFile.error) {
    return {
      rootNames: srcFiles,
      options: detectedDefaultOptions
    };
  }

  const shouldRespectExplicitModuleSettings =
    hasExplicitTsCompilerOption(configFile.config, "module") ||
    hasExplicitTsCompilerOption(configFile.config, "moduleResolution");
  const configParseDefaults = shouldRespectExplicitModuleSettings
    ? DEFAULT_TSC_OPTIONS
    : detectedDefaultOptions;

  const parsedConfig = tsc.parseJsonConfigFileContent(
    configFile.config,
    tsc.sys,
    dirname(configPath),
    configParseDefaults,
    configPath
  );
  const rootNames = [
    ...new Set([...srcFiles, ...parsedConfig.fileNames])
  ].sort();
  return {
    rootNames,
    options: {
      ...DEFAULT_TSC_OPTIONS,
      ...(shouldRespectExplicitModuleSettings ? {} : detectedDefaultOptions),
      ...parsedConfig.options,
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      resolveJsonModule: true
    }
  };
};

function createTsc(srcFiles, src) {
  try {
    const tscConfig = createTscProgramConfig(srcFiles, src);
    const program = tsc.createProgram(tscConfig.rootNames, tscConfig.options);
    const typeChecker = program.getTypeChecker();
    const seenTypes = new Map();

    const safeTypeToString = (type, context) => {
      try {
        return normalizeTypeString(
          typeChecker.typeToString(type, context, TSC_FLAGS),
          context
        );
      } catch (err) {
        return "any";
      }
    };

    const safeTypeWithContextToString = (node, context) => {
      try {
        return normalizeTypeString(
          typeChecker.typeToString(node, context, TSC_FLAGS),
          context
        );
      } catch (err) {
        return "any";
      }
    };

    const getExplicitTypeAnnotationString = (typeNode) => {
      if (!typeNode) {
        return undefined;
      }
      try {
        return safeTypeToString(
          typeChecker.getTypeFromTypeNode(typeNode),
          typeNode
        );
      } catch {
        return undefined;
      }
    };

    const addTypeAtPosition = (currentSeenTypes, position, typeStr) => {
      const scoreTypeString = (value) => {
        if (!value || isUnresolvedTypeString(value)) {
          return 0;
        }
        if (value.includes("=>")) {
          return 3;
        }
        if (
          value.includes("import(") ||
          value.includes("{") ||
          value.includes("|")
        ) {
          return 2;
        }
        return 1;
      };
      if (
        Number.isInteger(position) &&
        position >= 0 &&
        typeStr &&
        ![
          "any",
          "unknown",
          "any[]",
          "unknown[]",
          "error",
          "/*unresolved*/ any"
        ].includes(typeStr)
      ) {
        const existingType = currentSeenTypes.get(position);
        if (!existingType) {
          currentSeenTypes.set(position, typeStr);
          return;
        }
        const existingScore = scoreTypeString(existingType);
        const nextScore = scoreTypeString(typeStr);
        if (
          nextScore > existingScore ||
          (nextScore === existingScore && typeStr.length >= existingType.length)
        ) {
          currentSeenTypes.set(position, typeStr);
        }
      }
    };

    const isUnresolvedTypeString = (typeStr) =>
      [
        "any",
        "unknown",
        "any[]",
        "unknown[]",
        "error",
        "/*unresolved*/ any",
        "Promise<any>",
        "Promise<unknown>"
      ].includes(typeStr);

    const collectReturnExpressionTypes = (node, collectedTypes = new Set()) => {
      if (!node || !node.kind) {
        return collectedTypes;
      }
      if (tsc.isReturnStatement(node) && node.expression) {
        const returnType = safeTypeWithContextToString(
          typeChecker.getTypeAtLocation(node.expression),
          node.expression
        );
        if (returnType && !isUnresolvedTypeString(returnType)) {
          collectedTypes.add(returnType);
        } else {
          const inferredSyntaxType = inferExpressionTypeFromSyntax(
            node.expression
          );
          if (
            inferredSyntaxType &&
            !isUnresolvedTypeString(inferredSyntaxType)
          ) {
            collectedTypes.add(inferredSyntaxType);
          }
        }
        return collectedTypes;
      }
      if (
        node !== undefined &&
        !tsc.isFunctionDeclaration(node) &&
        !tsc.isFunctionExpression(node) &&
        !tsc.isArrowFunction(node) &&
        !tsc.isMethodDeclaration(node)
      ) {
        tsc.forEachChild(node, (child) =>
          collectReturnExpressionTypes(child, collectedTypes)
        );
      }
      return collectedTypes;
    };

    const inferAsyncReturnTypeFromBody = (node) => {
      if (!node.body) {
        return undefined;
      }
      if (!tsc.isBlock(node.body)) {
        const bodyType = safeTypeWithContextToString(
          typeChecker.getTypeAtLocation(node.body),
          node.body
        );
        return bodyType && !bodyType.startsWith("Promise<")
          ? `Promise<${bodyType}>`
          : bodyType;
      }
      const collectedTypes = collectReturnExpressionTypes(node.body);
      if (collectedTypes.size === 0) {
        return undefined;
      }
      const unionType = [...collectedTypes].sort().join(" | ");
      return unionType.startsWith("Promise<")
        ? unionType
        : `Promise<${unionType}>`;
    };

    const buildFunctionSignatureType = (node, returnTypeStr) => {
      if (!node.parameters) {
        return undefined;
      }
      const parameters = node.parameters.map((param) => {
        const parameterName = param.name?.getText?.() || "arg";
        const parameterType = safeTypeWithContextToString(
          typeChecker.getTypeAtLocation(param.name || param),
          param.name || param
        );
        return `${parameterName}: ${parameterType}`;
      });
      return `(${parameters.join(", ")}) => ${returnTypeStr}`;
    };

    const inferExpressionTypeFromSyntax = (expression) => {
      if (!expression) {
        return undefined;
      }
      if (
        tsc.isCallExpression(expression) &&
        expression.expression.kind === tsc.SyntaxKind.ImportKeyword &&
        expression.arguments.length > 0 &&
        tsc.isStringLiteralLike(expression.arguments[0])
      ) {
        return `Promise<typeof import("${normalizeImportedTypeSpecifier(
          expression.arguments[0].text,
          expression.getSourceFile().fileName
        )}")>`;
      }
      if (tsc.isAwaitExpression(expression)) {
        const awaitedType = inferExpressionTypeFromSyntax(
          expression.expression
        );
        return awaitedType?.startsWith("Promise<")
          ? awaitedType.slice(8, -1)
          : awaitedType;
      }
      if (tsc.isIdentifier(expression)) {
        const symbol = typeChecker.getSymbolAtLocation(expression);
        const declaration = symbol?.valueDeclaration;
        if (tsc.isVariableDeclaration(declaration) && declaration.initializer) {
          return inferExpressionTypeFromSyntax(declaration.initializer);
        }
      }
      if (tsc.isPropertyAccessExpression(expression)) {
        const baseType = inferExpressionTypeFromSyntax(expression.expression);
        if (baseType) {
          return `${baseType}.${expression.name.getText()}`;
        }
      }
      return undefined;
    };

    const inferFunctionDeclarationReturnType = (declaration) => {
      const signature = typeChecker.getSignatureFromDeclaration(declaration);
      if (!signature) {
        return undefined;
      }
      let inferredType = safeTypeToString(
        typeChecker.getReturnTypeOfSignature(signature),
        declaration.name || declaration
      );
      if (
        isUnresolvedTypeString(inferredType) &&
        (tsc.getCombinedModifierFlags(declaration) &
          tsc.ModifierFlags.Async) !==
          0
      ) {
        inferredType =
          inferAsyncReturnTypeFromSyntaxBody(declaration) ||
          inferAsyncReturnTypeFromBody(declaration) ||
          inferredType;
      }
      return inferredType;
    };

    const inferAsyncReturnTypeFromSyntaxBody = (node) => {
      if (!node?.body) {
        return undefined;
      }
      const collectedTypes = new Set();
      const visit = (currentNode) => {
        if (!currentNode || !currentNode.kind) {
          return;
        }
        if (tsc.isReturnStatement(currentNode) && currentNode.expression) {
          const inferredType = inferExpressionTypeFromSyntax(
            currentNode.expression
          );
          if (inferredType) {
            collectedTypes.add(inferredType);
          }
          return;
        }
        if (
          !tsc.isFunctionDeclaration(currentNode) &&
          !tsc.isFunctionExpression(currentNode) &&
          !tsc.isArrowFunction(currentNode) &&
          !tsc.isMethodDeclaration(currentNode)
        ) {
          tsc.forEachChild(currentNode, visit);
        }
      };
      if (tsc.isBlock(node.body)) {
        visit(node.body);
      } else {
        const inferredType = inferExpressionTypeFromSyntax(node.body);
        if (inferredType) {
          collectedTypes.add(inferredType);
        }
      }
      if (collectedTypes.size === 0) {
        return undefined;
      }
      const unionType = [...collectedTypes].sort().join(" | ");
      return unionType.startsWith("Promise<")
        ? unionType
        : `Promise<${unionType}>`;
    };

    const addType = (node, currentSeenTypes = seenTypes) => {
      // STRUCTURAL/CONTAINER NODES
      if (
        node.kind === tsc.SyntaxKind.SourceFile ||
        node.kind === tsc.SyntaxKind.Block ||
        node.kind === tsc.SyntaxKind.ImportDeclaration ||
        node.kind === tsc.SyntaxKind.ImportClause ||
        node.kind === tsc.SyntaxKind.NamedImports ||
        node.kind === tsc.SyntaxKind.NamespaceImport ||
        node.kind === tsc.SyntaxKind.ExportDeclaration ||
        node.kind === tsc.SyntaxKind.NamedExports ||
        node.kind === tsc.SyntaxKind.TypeAliasDeclaration ||
        node.kind === tsc.SyntaxKind.InterfaceDeclaration ||
        node.kind === tsc.SyntaxKind.ModuleDeclaration
      ) {
        tsc.forEachChild(node, (child) => addType(child, currentSeenTypes));
        return;
      }

      let typeStr;
      const isDirectCalleeIdentifier =
        tsc.isIdentifier(node) &&
        tsc.isCallExpression(node.parent) &&
        node.parent.expression === node;

      try {
        // WRAPPER NODES
        if (
          (tsc.SyntaxKind.SatisfiesExpression &&
            node.kind === tsc.SyntaxKind.SatisfiesExpression) ||
          node.kind === tsc.SyntaxKind.AsExpression ||
          node.kind === tsc.SyntaxKind.TypeAssertionExpression ||
          node.kind === tsc.SyntaxKind.NonNullExpression
        ) {
          typeStr = safeTypeWithContextToString(
            typeChecker.getTypeAtLocation(node),
            node
          );
        }
        // FUNCTION/METHOD SIGNATURES - extract return type AND parameter types
        else if (
          tsc.isFunctionLike(node) ||
          tsc.isMethodDeclaration(node) ||
          tsc.isGetAccessor(node) ||
          tsc.isSetAccessor(node) ||
          tsc.isCallSignatureDeclaration(node) ||
          tsc.isConstructSignatureDeclaration(node)
        ) {
          const signature = typeChecker.getSignatureFromDeclaration(node);
          if (signature) {
            const returnType = typeChecker.getReturnTypeOfSignature(signature);
            typeStr = safeTypeToString(returnType, node.name || node);
            if (
              isUnresolvedTypeString(typeStr) &&
              (tsc.getCombinedModifierFlags(node) & tsc.ModifierFlags.Async) !==
                0
            ) {
              typeStr =
                inferAsyncReturnTypeFromSyntaxBody(node) ||
                inferAsyncReturnTypeFromBody(node) ||
                typeStr;
            }
            // Also extract parameter types
            if (node.parameters) {
              for (const param of node.parameters) {
                try {
                  const paramType = typeChecker.getTypeAtLocation(param);
                  const paramTypeStr = safeTypeToString(
                    paramType,
                    param.name || param
                  );
                  if (paramTypeStr && paramTypeStr !== "any") {
                    currentSeenTypes.set(param.getStart(), paramTypeStr);
                  }
                } catch {
                  // ignore parameter type errors
                }
              }
            }
            if (node.name) {
              addTypeAtPosition(
                currentSeenTypes,
                node.name.getStart(),
                buildFunctionSignatureType(node, typeStr)
              );
            }
          } else {
            const funcType = typeChecker.getTypeAtLocation(node);
            const callSignatures = typeChecker.getSignaturesOfType(
              funcType,
              tsc.SignatureKind.Call
            );
            if (callSignatures.length > 0) {
              typeStr = safeTypeToString(
                callSignatures[0].getReturnType(),
                node.name || node
              );
            }
          }
        }
        // CLASS PROPERTIES - extract types for property declarations
        else if (node.kind === tsc.SyntaxKind.PropertyDeclaration) {
          if (node.type) {
            const propType = typeChecker.getTypeFromTypeNode(node.type);
            typeStr = safeTypeToString(propType, node.type);
          } else if (node.initializer) {
            const initType = typeChecker.getTypeAtLocation(node.initializer);
            typeStr = safeTypeWithContextToString(initType, node.initializer);
          }
        }
        // VARIABLE DECLARATIONS - extract types for loop variables and destructuring
        else if (
          node.kind === tsc.SyntaxKind.VariableDeclaration &&
          node.name
        ) {
          const explicitDeclaredType = getExplicitTypeAnnotationString(
            node.type
          );
          const varType = typeChecker.getTypeAtLocation(node.name);
          typeStr =
            explicitDeclaredType &&
            !isUnresolvedTypeString(explicitDeclaredType)
              ? explicitDeclaredType
              : safeTypeWithContextToString(varType, node.name);
          if (node.initializer && !explicitDeclaredType) {
            const initializerTarget = tsc.isPropertyAccessExpression(
              node.initializer
            )
              ? node.initializer.name
              : tsc.isElementAccessExpression(node.initializer) &&
                  node.initializer.argumentExpression
                ? node.initializer.argumentExpression
                : node.initializer;
            const initializerType = safeTypeWithContextToString(
              typeChecker.getTypeAtLocation(initializerTarget),
              initializerTarget
            );
            if (
              !isUnresolvedTypeString(initializerType) &&
              (isUnresolvedTypeString(typeStr) ||
                initializerType.length > typeStr.length)
            ) {
              typeStr = initializerType;
            }
            if (
              isUnresolvedTypeString(typeStr) &&
              tsc.isCallExpression(node.initializer) &&
              tsc.isIdentifier(node.initializer.expression)
            ) {
              const symbol = typeChecker.getSymbolAtLocation(
                node.initializer.expression
              );
              const declaration = symbol?.declarations?.find(
                (candidate) =>
                  tsc.isFunctionDeclaration(candidate) ||
                  tsc.isMethodDeclaration(candidate) ||
                  tsc.isFunctionExpression(candidate) ||
                  tsc.isArrowFunction(candidate)
              );
              if (declaration) {
                typeStr =
                  inferFunctionDeclarationReturnType(declaration) || typeStr;
              }
            }
          }
          addTypeAtPosition(currentSeenTypes, node.name.getStart(), typeStr);
        }
        // BINDING ELEMENTS - capture destructured member types precisely
        else if (node.kind === tsc.SyntaxKind.BindingElement && node.name) {
          const bindingType = typeChecker.getTypeAtLocation(node.name);
          typeStr = safeTypeWithContextToString(bindingType, node.name);
        }
        // PARAMETERS - capture parameter types even when not covered by signature extraction
        else if (node.kind === tsc.SyntaxKind.Parameter && node.name) {
          const parameterType = typeChecker.getTypeAtLocation(node.name);
          typeStr = safeTypeWithContextToString(parameterType, node.name);
        }
        // OBJECT LITERAL PROPERTIES - extract property value types
        else if (
          node.kind === tsc.SyntaxKind.PropertyAssignment &&
          node.initializer
        ) {
          const propType = typeChecker.getTypeAtLocation(node.initializer);
          typeStr = safeTypeWithContextToString(propType, node.initializer);
        }
        // SHORTHAND OBJECT PROPERTIES - preserve referenced symbol type
        else if (node.kind === tsc.SyntaxKind.ShorthandPropertyAssignment) {
          const shorthandType = typeChecker.getTypeAtLocation(node.name);
          typeStr = safeTypeWithContextToString(shorthandType, node.name);
        }
        // IMPORT CALLS - preserve module namespace typing for dynamic import()
        else if (
          node.kind === tsc.SyntaxKind.CallExpression &&
          node.expression?.kind === tsc.SyntaxKind.ImportKeyword
        ) {
          const importType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(importType, node);
        }
        // CALL EXPRESSIONS - extract return types
        else if (node.kind === tsc.SyntaxKind.CallExpression) {
          const callSig = typeChecker.getResolvedSignature(node);
          if (callSig) {
            const retType = callSig.getReturnType();
            typeStr = safeTypeToString(retType, node);
            if (
              isUnresolvedTypeString(typeStr) &&
              tsc.isIdentifier(node.expression)
            ) {
              const symbol = typeChecker.getSymbolAtLocation(node.expression);
              const declaration = symbol?.declarations?.find(
                (candidate) =>
                  tsc.isFunctionDeclaration(candidate) ||
                  tsc.isMethodDeclaration(candidate) ||
                  tsc.isFunctionExpression(candidate) ||
                  tsc.isArrowFunction(candidate)
              );
              if (declaration) {
                typeStr =
                  inferFunctionDeclarationReturnType(declaration) || typeStr;
              }
            }
          }
        }
        // NEW EXPRESSIONS - extract constructor return types
        else if (node.kind === tsc.SyntaxKind.NewExpression) {
          const newSig = typeChecker.getResolvedSignature(node);
          if (newSig) {
            const retType = newSig.getReturnType();
            typeStr = safeTypeToString(retType, node);
          }
        }
        // PROPERTY ACCESS - extract property types
        else if (
          node.kind === tsc.SyntaxKind.PropertyAccessExpression ||
          node.kind === tsc.SyntaxKind.ElementAccessExpression
        ) {
          const propType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(propType, node);
          if (node.kind === tsc.SyntaxKind.PropertyAccessExpression) {
            addTypeAtPosition(currentSeenTypes, node.name.getStart(), typeStr);
          } else if (node.argumentExpression) {
            addTypeAtPosition(
              currentSeenTypes,
              node.argumentExpression.getStart(),
              typeStr
            );
          }
        }
        // BINARY EXPRESSIONS - extract result types
        else if (node.kind === tsc.SyntaxKind.BinaryExpression) {
          const binType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(binType, node);
        }
        // CONDITIONAL EXPRESSIONS - extract union types
        else if (node.kind === tsc.SyntaxKind.ConditionalExpression) {
          const condType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(condType, node);
        }
        // LOGICAL EXPRESSIONS - extract result types
        else if (node.kind === tsc.SyntaxKind.LogicalExpression) {
          const logType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(logType, node);
        }
        // ARROW FUNCTION EXPRESSIONS - extract return types
        else if (node.kind === tsc.SyntaxKind.ArrowFunction) {
          const arrowSig = typeChecker.getSignatureFromDeclaration(node);
          if (arrowSig) {
            const retType = arrowSig.getReturnType();
            typeStr = safeTypeToString(retType, node);
            // Also extract parameter types for arrow functions
            if (node.parameters) {
              for (const param of node.parameters) {
                try {
                  const paramType = typeChecker.getTypeAtLocation(param);
                  const paramTypeStr = safeTypeToString(
                    paramType,
                    param.name || param
                  );
                  if (paramTypeStr && paramTypeStr !== "any") {
                    currentSeenTypes.set(param.getStart(), paramTypeStr);
                  }
                } catch {
                  // ignore
                }
              }
            }
          }
        }
        // CLASS DECLARATIONS - extract class instance types
        else if (
          node.kind === tsc.SyntaxKind.ClassDeclaration ||
          node.kind === tsc.SyntaxKind.ClassExpression
        ) {
          const classType = typeChecker.getTypeAtLocation(node);
          const constructSigs = typeChecker.getSignaturesOfType(
            classType,
            tsc.SignatureKind.Construct
          );
          if (constructSigs.length > 0) {
            typeStr = safeTypeToString(constructSigs[0].getReturnType(), node);
          }
        }
        // ENUM MEMBERS - preserve literal enum member types for TypeScript projects
        else if (node.kind === tsc.SyntaxKind.EnumMember) {
          const enumMemberType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(enumMemberType, node);
        }
        // TEMPLATE EXPRESSIONS - extract string types
        else if (
          node.kind === tsc.SyntaxKind.TemplateExpression ||
          node.kind === tsc.SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
          const tmplType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(tmplType, node);
        }
        // TAGGED TEMPLATE EXPRESSIONS - extract tagged template types
        else if (node.kind === tsc.SyntaxKind.TaggedTemplateExpression) {
          const tagType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(tagType, node);
        }
        // YIELD EXPRESSIONS - extract yielded types
        else if (node.kind === tsc.SyntaxKind.YieldExpression) {
          const yieldType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(yieldType, node);
        }
        // SPREAD ELEMENTS - extract spread element types
        else if (node.kind === tsc.SyntaxKind.SpreadElement) {
          const spreadType = typeChecker.getTypeAtLocation(node.expression);
          typeStr = safeTypeWithContextToString(spreadType, node.expression);
        }
        // DELETE EXPRESSIONS - extract result types
        else if (node.kind === tsc.SyntaxKind.DeleteExpression) {
          const delType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(delType, node);
        }
        // TYPEOF EXPRESSIONS - extract result types
        else if (node.kind === tsc.SyntaxKind.TypeOfExpression) {
          const typeofType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(typeofType, node);
        }
        // VOID EXPRESSIONS - extract result types
        else if (node.kind === tsc.SyntaxKind.VoidExpression) {
          const voidType = typeChecker.getTypeAtLocation(node);
          typeStr = safeTypeWithContextToString(voidType, node);
        }
        // STANDARD EXPRESSIONS & IDENTIFIERS
        else {
          let typeObj = typeChecker.getTypeAtLocation(node);
          if (
            typeObj.isLiteral() ||
            typeObj.flags & tsc.TypeFlags.BooleanLiteral
          ) {
            try {
              typeObj = typeChecker.getBaseTypeOfLiteralType(typeObj);
            } catch (e) {
              // ignore
            }
          }
          typeStr = safeTypeWithContextToString(typeObj, node);
        }
        if (
          !isDirectCalleeIdentifier &&
          typeStr &&
          ![
            "any",
            "unknown",
            "any[]",
            "unknown[]",
            "error",
            "/*unresolved*/ any"
          ].includes(typeStr)
        ) {
          addTypeAtPosition(currentSeenTypes, node.getStart(), typeStr);
        }
      } catch (err) {
        // Silently fail on type resolution errors
      }
      tsc.forEachChild(node, (child) => addType(child, currentSeenTypes));
    };

    const collectTypes = (sourceFile) => {
      const fileSeenTypes = new Map();
      tsc.forEachChild(sourceFile, (node) => addType(node, fileSeenTypes));
      return fileSeenTypes;
    };

    return {
      program: program,
      typeChecker: typeChecker,
      rootNames: tscConfig.rootNames,
      addType: addType,
      collectTypes: collectTypes,
      seenTypes: seenTypes
    };
  } catch (err) {
    return undefined;
  }
}

/**
 * Generate AST for JavaScript or TypeScript
 */
const createJSAst = async (options) => {
  try {
    const promiseMap = await getAllSrcJSAndTSFiles(options.src);
    let srcFiles = promiseMap.flatMap((d) => d).sort();
    let ts;
    if (options.tsTypes) {
      const projectFiles = !shouldIncludeNodeModulesBundles
        ? srcFiles.filter((file) => !file.includes("node_modules"))
        : srcFiles;
      ts = createTsc(projectFiles, options.src);
      if (ts?.rootNames) {
        const srcRoot = resolve(options.src);
        const srcFileByResolvedPath = new Map(
          srcFiles.map((file) => [resolve(file), file])
        );
        for (const file of ts.rootNames) {
          const resolvedFile = resolve(file);
          if (
            resolvedFile.startsWith(srcRoot) &&
            /\.(?:js|jsx|cjs|mjs|ts|tsx|mts|cts)$/.test(file) &&
            !srcFileByResolvedPath.has(resolvedFile)
          ) {
            srcFileByResolvedPath.set(
              resolvedFile,
              join(options.src, relative(srcRoot, resolvedFile))
            );
          }
        }
        srcFiles = [...srcFileByResolvedPath.values()].sort();
      }
    }
    const CONCURRENCY_LIMIT = Math.max(
      1,
      Number.parseInt(process.env.ASTGEN_CONCURRENCY || "10", 10) || 10
    );
    const chunks = [];
    for (let i = 0; i < srcFiles.length; i += CONCURRENCY_LIMIT) {
      chunks.push(srcFiles.slice(i, i + CONCURRENCY_LIMIT));
    }
    for (const chunk of chunks) {
      await Promise.all(chunk.map((file) => processFile(file, options, ts)));
      if (typeof globalThis.gc === "function") {
        try {
          globalThis.gc();
        } catch (e) {
          // ignore
        }
      } else if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
        try {
          Bun.gc(true);
        } catch (e) {
          // ignore
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
};

const processFile = (file, options, ts) => {
  try {
    const astOrResult = fileToJsAst(file, options.type, ts);
    let ast = astOrResult;

    // When toVueAst returns { ast, seenTypes } we write the typemap directly.
    if (
      astOrResult &&
      typeof astOrResult === "object" &&
      astOrResult.seenTypes
    ) {
      ast = astOrResult.ast;
      writeAstFile(file, ast, options);
      writeTypesFile(file, astOrResult.seenTypes, options);
    } else {
      writeAstFile(file, ast, options);
      if (ts) {
        try {
          const tsAst = ts.program.getSourceFile(file);
          if (tsAst) {
            const seenTypes = ts.collectTypes
              ? ts.collectTypes(tsAst)
              : (() => {
                  tsc.forEachChild(tsAst, ts.addType);
                  const collectedTypes = new Map(ts.seenTypes);
                  ts.seenTypes.clear();
                  return collectedTypes;
                })();
            writeTypesFile(file, seenTypes, options);
          }
        } catch (err) {}
      }
    }
  } catch (err) {
    console.error("Failure:", file, err?.message);
  }
};

/**
 * Generate AST for .vue files
 */
const createVueAst = async (options) => {
  const srcFiles = await getAllFiles(options.src, ".vue");
  for (const file of srcFiles) {
    try {
      const ast = toVueAst(file);
      if (ast) {
        writeAstFile(file, ast, options);
      }
    } catch (err) {
      console.error(file, err.message);
    }
  }
};

/**
 * Deal with cyclic reference in json
 */
const getCircularReplacer = () => {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
    }
    return value;
  };
};

/**
 * Write AST data to a json file
 */
const writeAstFile = (file, ast, options) => {
  const relativePath = file.replace(new RegExp("^" + options.src + "/"), "");
  const outAstFile = join(options.output, relativePath + ".json");
  const data = {
    fullName: file,
    relativeName: relativePath,
    ast: ast
  };
  mkdirSync(dirname(outAstFile), { recursive: true });
  writeFileSync(
    outAstFile,
    JSON.stringify(data, getCircularReplacer(), undefined)
  );
  console.log("Converted AST for", relativePath, "to", outAstFile);
};

const writeTypesFile = (file, seenTypes, options) => {
  const relativePath = file.replace(new RegExp("^" + options.src + "/"), "");
  const outTypeFile = join(options.output, relativePath + ".typemap");
  mkdirSync(dirname(outTypeFile), { recursive: true });
  writeFileSync(
    outTypeFile,
    JSON.stringify(Object.fromEntries(seenTypes), undefined, undefined)
  );
  console.log("Converted types for", relativePath, "to", outTypeFile);
};

const createXAst = async (options) => {
  const src_dir = options.src;
  try {
    accessSync(src_dir, constants.R_OK);
  } catch (err) {
    console.error(src_dir, "is invalid");
    process.exit(1);
  }
  if (
    existsSync(join(src_dir, "package.json")) ||
    existsSync(join(src_dir, "rush.json"))
  ) {
    return await createJSAst(options);
  }
  console.error(src_dir, "unknown project type");
  process.exit(1);
};

/**
 * Method to start the ast generation process
 *
 * @args options CLI arguments
 */
const start = async (options) => {
  let { type } = options;
  if (!type) {
    type = "";
  }
  type = type.toLowerCase();
  switch (type) {
    case "nodejs":
    case "js":
    case "javascript":
    case "typescript":
    case "ts":
    case "flow":
      return await createJSAst(options);
    case "vue":
      return await createVueAst(options);
    default:
      return await createXAst(options);
  }
};

async function main(argvs) {
  const args = parseCliArgs(argvs);

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.version) {
    console.log(ASTGEN_VERSION);
    process.exit(0);
  }

  try {
    if (args.output === "ast_out") {
      args.output = join(args.src, args.output);
    }
    await start(args);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main(process.argv);

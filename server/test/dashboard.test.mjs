/*
 * 面板静态自检（纯 Node，不需要浏览器）：
 *     node server/test/dashboard.test.mjs
 *
 * 存在的意义：面板改动的"真实验证"需要开浏览器，而浏览器工具经常不在手边。
 * 这个脚本能拦住最容易犯的两类错：
 *   1. 内联 JS 语法错误 —— 整块脚本挂掉，面板直接变成白板
 *   2. $('xxx') 引用了 HTML 里不存在的元素 —— 运行时才炸，且只在特定分支炸
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'static', 'dashboard.html'), 'utf8');

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : `  ${extra}`}`);
};

// ---------------------------------------------------------------- 抽内联脚本
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('找到内联 script 块', inlineScripts.length > 0, `实际 ${inlineScripts.length} 个`);
const code = inlineScripts.join('\n');

// 语法检查（只解析不执行）
try {
  new Function(code); // eslint-disable-line no-new-func
  check('内联 JS 语法可解析', true);
} catch (e) {
  check('内联 JS 语法可解析', false, String(e.message));
}

// ---------------------------------------------------------------- 元素引用
const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const refs = new Set([
  ...[...code.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...code.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
]);
const missing = [...refs].filter((id) => !idsInHtml.has(id));
check(`$() 引用的元素都存在（共 ${refs.size} 个）`, missing.length === 0, missing.length ? `缺少: ${missing.join(', ')}` : '');

// ---------------------------------------------------------------- 关键结构
const mustHave = ['roomSel', 'onlyActive', 'roomCount', 'metricBar', 'chart', 'csvLink', 'diagHint'];
const missingMust = mustHave.filter((id) => !idsInHtml.has(id));
check('关键元素齐全', missingMust.length === 0, missingMust.length ? `缺少: ${missingMust.join(', ')}` : '');

// 房间下拉框必须"条件重建"，不能每轮无条件清空（这是 tier: 选不中房间 那个 bug 的根源）
check(
  'loadRooms 不会无条件重建下拉框',
  !/async function loadRooms[\s\S]{0,600}?sel\.innerHTML = '';\s*\n\s*if \(!data\.rooms\.length\)/.test(code)
);
check('存在"用户操作下拉框时跳过重建"的保护', code.includes('selectBusy'));

// 指标按钮必须是动态生成的（不能又回到写死三个按钮）
check('指标按钮动态生成', code.includes('renderMetricBar') && !/class="metric active" data-metric=/.test(html));

console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 条失败。`);
process.exit(failed === 0 ? 0 : 1);

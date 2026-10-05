# -*- coding: utf-8 -*-
"""
变异验证：把新加的行为断言逐条"造坏"，确认它真的会红。

为什么必须做：断言写出来是绿的，只证明"当前代码通过了它"，
不证明"它守着什么东西"。唯一能证明的办法是把被测行为改坏一次，
看那条断言是否准确地红掉 —— 没红的就是装饰品。

用法：python tools/mutate-verify.py
每个变异跑完立刻从备份还原，并核对 sha256，绝不留下改动。
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["app.js", "index.html", "styles.css"]
BAK = {f: ROOT / (f + ".mutbak") for f in FILES}

NODE = os.environ.get("NODE") or shutil.which("node") or "node"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_suite():
    r = subprocess.run(
        [NODE, "test-parse.js"], cwd=str(ROOT),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = (r.stdout or "") + (r.stderr or "")
    failed = [ln for ln in out.splitlines() if ln.lstrip().startswith("\u2717")]
    m = re.search(r"结果：(\d+) 通过 / (\d+) 失败", out)
    totals = (m.group(1), m.group(2)) if m else None
    return failed, totals, out


# (编号, 说明, 文件, 原片段, 变异片段, 期望红掉的断言里的特征串)
# expect 以 "MISS:" 开头 = 探针，意思相反：期望**整套仍然全绿**（＝这处没被覆盖）
MUTATIONS = [
    ("A1", "safeUrl 不再判协议（还原成只 trim）", "app.js",
     "const safeUrl = (u) => {\n    const s = String(u == null ? '' : u).trim();\n    return /^https?:\\/\\//i.test(s) ? s : '';\n  };",
     "const safeUrl = (u) => String(u == null ? '' : u).trim();",
     "不渲染可执行的 href"),

    ("A2", "safeImg 不再判协议", "app.js",
     "const safeImg = (u) => {\n    const s = String(u == null ? '' : u).trim();\n    return /^https?:\\/\\//i.test(s) ? s : '';\n  };",
     "const safeImg = (u) => String(u == null ? '' : u).trim();",
     "协议相对的图片地址不渲染"),

    ("A3", "演示模式也渲染真图（撤掉演示隔离）", "app.js",
     "const thumb = data.demo",
     "const thumb = false && data.demo",
     "一个 <img> 都没有"),

    ("A4", "商品标题不再回落到商品名", "app.js",
     '<div class="row-name">${esc(it.title || product)}</div>',
     '<div class="row-name">${esc(it.title)}</div>',
     "it.title 缺字段时回落到商品名"),

    ("B1", "rankPrice 回到裸 Number（null 变成 0）", "app.js",
     "const v = numOrNull(f && f.price);\n    return v === null ? Infinity : v;",
     "const v = Number(f && f.price);\n    return isFinite(v) ? v : Infinity;",
     "price: null 排在最后且显示"),

    ("B2", "航班价格位不再用统一判据（null 印成 0）", "app.js",
     "priceVal === null ? '—' : Math.round(priceVal)",
     "f.price == null ? '0' : (priceVal === null ? '—' : Math.round(priceVal))",
     "price: null 不会被当成 ¥0"),

    ("B3", "「最便宜」改回按行号盖（全不可信也盖）", "app.js",
     "const isBest = i === 0 && priceVal !== null;",
     "const isBest = i === 0;",
     "全部价格都不可信时一条「最便宜」也不标"),

    ("B4", "stopsText 不再兜底（filter(Boolean) 拦不住）", "app.js",
     "esc(f.stopsText || '')",
     "esc(f.stopsText)",
     "stopsText 缺字段时 meta 里不出现 undefined"),

    ("B5", "carrier 不再兜底", "app.js",
     "esc(f.carrier || '—')",
     "esc(f.carrier)",
     "carrier 缺字段时航司名显示"),

    ("C1", "截断的 % 转义直接抛（撤掉 try/catch）", "app.js",
     "try { kw = decodeURIComponent(m[1].replace(/\\+/g, ' ')); } catch { kw = ''; }",
     "kw = decodeURIComponent(m[1].replace(/\\+/g, ' '));",
     "截断链接不会抛 URIError"),

    ("C2", "撤掉 truncated 说明卡分支", "app.js",
     "} else if (p.kind === 'truncated') {",
     "} else if (false) {",
     "截断链接给出一张说明卡"),

    ("C3", "localStorage 读取不再兜异常", "app.js",
     "try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }",
     "return JSON.parse(localStorage.getItem(k) || 'null');",
     "localStorage 读写都抛异常时导入关注不崩"),

    ("C4", "兜底 textarea 不再放 finally 里收", "app.js",
     "      finally { if (ta.remove) ta.remove(); }",
     "      if (false) { if (ta.remove) ta.remove(); }",
     "execCommand 抛异常时兜底 textarea 也被摘掉"),

    # 忠实还原**旧代码**的写法：无条件画那一行 + money(0) 顶上。
    # （第一版变异只把守卫去掉、没补 money(0)，结果渲染直接抛异常 ——
    #   暴露出我那条断言"靠文字不存在来通过"的假绿，顺手也把断言修硬了。）
    ("D1", "分件买最优改回无条件画 + money(0) 占位（编一个 0）", "app.js",
     "      if (data.split) {\n        const who = (data.split.platforms || [])\n"
     "          .map((p) => esc(p.name) + ' \u00a5' + fmtPrice(p.subtotal)).join('\u3000');\n"
     "        planRows.push(`\n"
     "          <div class=\"plan-row ${isSplit ? 'pick' : ''}\">\n"
     "            <div>\n"
     "              <div class=\"plan-name\">\u5206\u4ef6\u4e70\u6700\u4f18${isSplit ? ' <span class=\"badge badge-best\">\u5efa\u8bae</span>' : ''}</div>\n"
     "              <div class=\"plan-meta\">${data.split.platformCount || 0} \u4e2a\u5e73\u53f0\uff1a${who || '\u2014'}</div>\n"
     "            </div>\n"
     "            <div class=\"plan-total\">${money(data.split.total)}</div>\n"
     "          </div>`);\n"
     "      }",
     "      {\n        const sp = data.split || {};\n        const who = (sp.platforms || [])\n"
     "          .map((p) => esc(p.name) + ' \u00a5' + fmtPrice(p.subtotal)).join('\u3000');\n"
     "        planRows.push(`\n"
     "          <div class=\"plan-row ${isSplit ? 'pick' : ''}\">\n"
     "            <div>\n"
     "              <div class=\"plan-name\">\u5206\u4ef6\u4e70\u6700\u4f18${isSplit ? ' <span class=\"badge badge-best\">\u5efa\u8bae</span>' : ''}</div>\n"
     "              <div class=\"plan-meta\">${sp.platformCount || 0} \u4e2a\u5e73\u53f0\uff1a${who || '\u2014'}</div>\n"
     "            </div>\n"
     "            <div class=\"plan-total\">${money(sp.total || 0)}</div>\n"
     "          </div>`);\n"
     "      }",
     "没算出分件方案时，「分件买最优」整行不画"),

    ("D2", "planned 判断挪回探测结果之后", "app.js",
     "    if (a.planned) return false;\n    if (HEALTH_IDS) return HEALTH_IDS.has(a.id);",
     "    if (HEALTH_IDS) return HEALTH_IDS.has(a.id);\n    if (a.planned) return false;",
     "目录声明 planned 的数据源，即使被服务端列进 adapters"),

    ("E1", "抽屉关闭时不再 inert（撤掉互锁）", "app.js",
     "    if (drawer) drawer.inert = !dOpen;",
     "    /* 变异：撤掉 */",
     "抽屉关着的时候自己就是 inert 的"),

    ("E2", "抽屉的 role/aria-modal 撤掉", "index.html",
     'class="drawer" id="drawer" role="dialog" aria-modal="true"',
     'class="drawer" id="drawer" role="complementary"',
     '两个抽屉都补了 role="dialog"'),

    # ---- 下面两条是"故意期望它**不**红"的探针 ----
    # 用来量出这套覆盖的边界。它们对应补丁里我确实没写断言的两处行为，
    # 期望结果就是 UNCOV（整套仍全绿）。哪天变红 = 覆盖补上了，是好事。
    ("D3*", "【探针】PLAT_LABEL 撤掉（dataoke 平台名回落）", "app.js",
     "const PLAT_LABEL = { dataoke: '淘宝 / 天猫' };",
     "const PLAT_LABEL = {};",
     "MISS:"),

    ("A6*", "【探针】styles.css 里撤掉 .row-img 缩略图样式", "styles.css",
     ".row-img{",
     ".row-img-mutated-out{",
     "MISS:"),
]

MARKS = {"RED": "\u2713", "MISS": "\u2717", "SKIP": "-", "CRASH": "!",
         "COVERED": "\u2713", "UNCOV": "\u25cb"}


def main():
    for f in FILES:
        shutil.copyfile(ROOT / f, BAK[f])
    base = {f: sha(ROOT / f) for f in FILES}

    results = []
    try:
        for no, desc, fn, find, repl, expect in MUTATIONS:
            p = ROOT / fn
            txt = p.read_text(encoding="utf-8")
            if find not in txt:
                results.append((no, desc, "SKIP", "找不到原片段"))
                continue
            p.write_text(txt.replace(find, repl, 1), encoding="utf-8")
            failed, totals, out = run_suite()

            if expect.startswith("MISS:"):
                # 探针问的是"我这套测试到底管不管这处行为"。
                # 基线是全绿，所以只要有任何一条红，就说明它被覆盖了。
                if totals is None:
                    verdict = "CRASH"
                elif failed:
                    verdict = "COVERED"
                else:
                    verdict = "UNCOV"
            else:
                hit = any(expect in ln for ln in failed)
                verdict = "CRASH" if totals is None else ("RED" if hit else "MISS")

            if verdict == "UNCOV":
                detail = "整套全绿 → 这处行为没有任何断言守着"
            elif totals:
                detail = "汇总 %s 通过 / %s 失败" % totals
                if verdict == "MISS":
                    detail += "；未红的前 3 条: " + (
                        " | ".join(x.strip()[:60] for x in failed[:3]) if failed else "一条都没红")
            else:
                detail = "套件没打印汇总行，尾部：" + out.strip()[-160:].replace("\n", " ")

            results.append((no, desc, verdict, detail))

            shutil.copyfile(BAK[fn], p)
            if sha(p) != base[fn]:
                print("还原失败！%s sha256 不一致" % fn)
                sys.exit(2)
    finally:
        for f in FILES:
            shutil.copyfile(BAK[f], ROOT / f)
            BAK[f].unlink(missing_ok=True)

    for f in FILES:
        assert sha(ROOT / f) == base[f], "%s 未还原" % f

    print("\n=== 变异验证结果 ===")
    for no, desc, verdict, detail in results:
        print("%s %-5s %-44s %-8s %s" % (MARKS.get(verdict, "?"), no, desc, verdict, detail))

    probe = [r for r in results if r[0].endswith("*")]
    normal = [r for r in results if not r[0].endswith("*")]
    bad = [r for r in normal if r[2] != "RED"]
    print("\n正经变异 %d 个：%d 个如期变红，%d 个没红" % (len(normal), len(normal) - len(bad), len(bad)))
    if probe:
        print("边界探针 %d 个：%s" % (len(probe), "、".join(
            "%s=%s" % (r[0], r[2]) for r in probe)))
    print("源文件已恢复且 sha256 一致：" + ", ".join("%s=%s" % (f, base[f][:16]) for f in FILES))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

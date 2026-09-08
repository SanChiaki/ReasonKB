#!/usr/bin/env python3
"""Verify and summarize frozen standard-v1 records without model/network access."""
import argparse
import hashlib
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'benchmarks/standard-v1'
SYSTEMS = ('ReasonKB-C', 'ReasonKB-D', 'fastgpt', 'ragflow')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def verify(root):
    manifest = read(root / 'manifest.json')
    for name, digest in manifest['files'].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f'Checksum mismatch: {name}')
    for suite, config in manifest['suites'].items():
        questions = read(root / suite / 'questions.json')
        ids = {q['id'] for q in questions if q['included']}
        assert len(questions) == config['candidates']
        assert len({q['id'] for q in questions}) == len(questions)
        assert len(ids) == config['included']
        rows = read(root / suite / 'baseline.json')
        assert len(rows) == len(ids) * len(SYSTEMS)
        assert {(r['questionId'], r['system']) for r in rows} == {(i, s) for i in ids for s in SYSTEMS}
        assert all(q['exclusionReason'] for q in questions if not q['included'])
    return manifest


def mean(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return statistics.mean(values) if values else None


def quantile(values, probability):
    values = sorted(v for v in values if isinstance(v, (int, float)))
    if not values:
        return None
    pos = (len(values) - 1) * probability
    lower = int(pos)
    return values[lower] + (values[min(lower + 1, len(values) - 1)] - values[lower]) * (pos - lower)


def metrics(rows, suite):
    natural = suite == 'natural80'
    page_key = 'referencePageRecall@1' if natural else 'pageRecallAt1'
    values = [r['metrics']['returnedEvidence']['coverage'] if natural else r['auditMetrics'].get('evidenceElementCoverage') for r in rows]
    full = [r['metrics']['returnedEvidence']['allElements'] if natural else r['auditMetrics'].get('allElementsCovered') for r in rows]
    return {
        'n': len(rows),
        'pageAt1': mean([r['pageMetrics'].get(page_key) for r in rows]),
        'coverage': mean(values), 'coverageN': sum(isinstance(v, (int, float)) for v in values),
        'allElements': mean(full),
        'needsReview': sum(r['scoreStatus'] != 'ok' for r in rows),
        'retrievalErrors': sum(r['retrievalStatus'] not in ('ok', 'matched', 'no_match', 'degraded') for r in rows),
        'degraded': sum(r['retrievalStatus'] == 'degraded' for r in rows),
        'p50Ms': quantile([r['latencyMs'] for r in rows], .5),
        'p90Ms': quantile([r['latencyMs'] for r in rows], .9),
        'p95Ms': quantile([r['latencyMs'] for r in rows], .95),
    }


def report(root):
    verify(root)
    lines = ['# Standard evaluation v1 — frozen historical baseline', '',
             '80 题：全库 616 文档、limit5、完整 evidence.content。214 候选：210 纳入、正确文档注入。',
             '以下覆盖率包含历史待复核评分；不是人工准确率。两套题不合并求平均，不把 C/D 求平均。',
             '80 题页@1 是必需页召回；210 题页@1 是任一参考页命中。coverageN 显式给出有效分母。',
             '时延含全部记录（包括失败）；214 扣除原生答案耗时。不可与仅成功请求的旧报告混用。', '']
    for suite in ('natural80', 'mmlongbench214'):
        rows = read(root / suite / 'baseline.json')
        groups = ['all'] + sorted({r['group'] for r in rows})
        for group in groups:
            lines += [f'## {suite} / {group}', '', '| System | N | 页@1 | 覆盖 | coverageN | 全齐 | 待复核/评分异常 | 检索错误 | degraded | P50 s | P90 s | P95 s |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
            for system in SYSTEMS:
                selected = [r for r in rows if r['system'] == system and (group == 'all' or r['group'] == group)]
                m = metrics(selected, suite)
                pct = lambda x: 'NA' if x is None else f'{100*x:.1f}%'
                sec = lambda x: 'NA' if x is None else f'{x/1000:.1f}'
                lines.append(f"| {system} | {m['n']} | {pct(m['pageAt1'])} | {pct(m['coverage'])} | {m['coverageN']} | {pct(m['allElements'])} | {m['needsReview']} | {m['retrievalErrors']} | {m['degraded']} | {sec(m['p50Ms'])} | {sec(m['p90Ms'])} | {sec(m['p95Ms'])} |")
            lines.append('')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('verify', 'report'))
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.command == 'verify':
        verify(args.root)
        print('Verified: 108/80 + 214/210 questions, 1160 baseline records, all checksums.')
    else:
        result = report(args.root)
        if args.output:
            args.output.write_text(result, encoding='utf-8')
        else:
            print(result, end='')


if __name__ == '__main__':
    main()

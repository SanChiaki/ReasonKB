#!/usr/bin/env python3
"""Run frozen questions against an isolated copy of a ReasonKB index snapshot.

Collects full evidence and deterministic page recall; does not fabricate semantic
judge scores. Credentials are supplied by the normal ReasonKB environment.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from standard_eval import ROOT, read, verify


def page_numbers(value):
    result = []
    for a, b in re.findall(r'(\d+)(?:\s*-\s*(\d+))?', str(value or '')):
        result.extend(range(int(a), int(b or a) + 1))
    return list(dict.fromkeys(result))


def recall(gold, returned, k):
    if not gold:
        return None
    return len(set(gold) & set(returned[:k])) / len(set(gold))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=('natural80', 'mmlongbench214'), required=True)
    parser.add_argument('--db', type=Path, required=True, help='Index snapshot; never modified')
    parser.add_argument('--projects', nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True, help='New run directory; must not exist')
    parser.add_argument('--mode', choices=('C', 'D'), default='C')
    parser.add_argument('--limit', type=int, help='Smoke only; cannot serve as full benchmark')
    args = parser.parse_args()
    manifest = verify(ROOT)
    if not args.db.is_file():
        parser.error('Source database does not exist')
    if args.limit is not None and args.limit <= 0:
        parser.error('--limit must be positive')
    args.output.mkdir(parents=True, exist_ok=False)
    db = (args.output / 'runtime.sqlite').resolve()
    with sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(db) as target:
            source.backup(target)
    policies = manifest['modes'][args.mode]
    os.environ.update(dict(zip(('REASONKB_TREE_SEARCH_POLICY', 'REASONKB_EVIDENCE_VALIDATION_POLICY', 'REASONKB_ANSWER_POLICY'), policies)))
    os.environ['APP_DB_PATH'] = str(db)
    os.environ['APP_VAR_ROOT'] = str(db.parent)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from services.retrieval_api import query_engine as engine
    from services.retrieval_api.select_documents import CandidateDocuments, EVIDENCE_VALIDATION_REASON_KEY
    questions = [q for q in read(ROOT / args.suite / 'questions.json') if q['included']]
    docs = engine._load_ready_documents(str(db), args.projects)
    if args.suite == 'natural80':
        expected = {d['id'] for d in read(ROOT / args.suite / 'corpus-manifest.json')}
        if {d['id'] for d in docs} != expected:
            parser.error('Full-corpus snapshot must contain exactly the frozen 616 document IDs')
        with sqlite3.connect(db) as conn:
            conn.execute("UPDATE system_settings SET value_json='5' WHERE key='retrievalDocumentLimit'")
    else:
        names = {d['file_name'] for d in docs}
        if not {q['source']['doc_id'] for q in questions} <= names:
            parser.error('Missing gold documents in the selected projects')
        by_query = {q['query']: q['source']['doc_id'] for q in questions}
        def inject(query, docs, limit=5, model=None, mode=None):
            selected = [{**d, EVIDENCE_VALIDATION_REASON_KEY: 'gold_document_injection'} for d in docs if d['file_name'] == by_query[query]]
            if len(selected) != 1:
                raise ValueError('Gold document must resolve uniquely')
            return CandidateDocuments(selected, model_outcome='gold_injected', strategy='gold_document_injection', semantic_status='not_run', semantic_elapsed_ms=0)
        engine.select_candidate_documents = inject
    config = {'suite': args.suite, 'mode': args.mode, 'policies': policies, 'scope': manifest['suites'][args.suite]['scope'], 'outputMode': 'evidence', 'smoke': args.limit is not None, 'projects': args.projects, 'manifestSha256': hashlib.sha256((ROOT/'manifest.json').read_bytes()).hexdigest(), 'sourceDatabase': str(args.db.resolve()), 'gitRevision': subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'semanticScoring': 'not_run', 'note': 'Evidence-only regression; not equivalent to historical answer-mode timings or semantic scores.'}
    (args.output/'run.json').write_text(json.dumps(config, indent=2)+'\n')
    for q in questions[:args.limit]:
        start = time.perf_counter()
        try:
            raw = engine.answer_question(str(db), q['query'], args.projects, mode='evidence')
            error = None
        except Exception as exc:
            raw = {'evidence': [], 'retrievalStatus': 'error'}
            error = f'{type(exc).__name__}: {exc}'
        returned = list(dict.fromkeys((e['documentId'], p) for e in raw.get('evidence', []) for p in page_numbers(e.get('pages'))))
        if args.suite == 'natural80':
            gold = list(dict.fromkeys((s['documentId'], s['page']) for e in q['gold']['value']['elements'] for s in e['supports']))
        else:
            docid = next(d['id'] for d in docs if d['file_name'] == q['source']['doc_id'])
            gold = [(docid, p) for p in q['source']['goldPages']]
        row = {'questionId': q['id'], 'raw': raw, 'error': error, 'latencyMs': round((time.perf_counter()-start)*1000), 'requiredPageRecall': {str(k): recall(gold, returned, k) for k in (1, 5, 10)}, 'semanticScore': None}
        (args.output/(q['id']+'.json')).write_text(json.dumps(row, ensure_ascii=False, indent=2)+'\n')
        print(q['id'], raw.get('retrievalStatus'), flush=True)


if __name__ == '__main__':
    main()

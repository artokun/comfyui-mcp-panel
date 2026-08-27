/**
 * Reference identity helpers shared by the release generator and its guard.
 *
 * A squash subject commonly names the tracked issue in its scope and the PR
 * that merged it at the end, for example `fix(1882): ... (#1885)`. Those are
 * two spellings of one shipped change, not two changelog entries.
 */

export function referenceNumbers(text) {
  return [...String(text ?? "").matchAll(/\(#(\d+)\)/g)].map((m) => m[1]);
}

/** References in a conventional commit subject, including numeric issue scopes. */
export function commitReferences(subject) {
  const text = String(subject ?? "");
  const refs = referenceNumbers(text);
  const match = /^(?:\w+)(?:\(([^)]+)\))?(?:!)?:\s*/.exec(text);
  if (match && /^#?\d+$/.test(match[1] ?? "")) refs.unshift((match[1] ?? "").replace(/^#/, ""));
  return [...new Set(refs)];
}

/**
 * Build equivalence classes for issue/PR references that occur together in a
 * commit subject. An issue is only linked when it has one PR in the supplied
 * history; an umbrella issue used by several follow-up PRs stays distinct so
 * deduplication cannot hide legitimate fixes.
 */
export function referenceAliases(commits) {
  const candidates = new Map();
  for (const commit of commits ?? []) {
    const refs = commit?.refs ?? commitReferences(commit?.subject);
    if (refs.length < 2) continue;
    const pr = refs.at(-1);
    for (const issue of refs.slice(0, -1)) {
      if (issue === pr) continue;
      if (!candidates.has(issue)) candidates.set(issue, new Set());
      candidates.get(issue).add(pr);
    }
  }

  const parent = new Map();

  const ensure = (ref) => {
    if (!parent.has(ref)) parent.set(ref, ref);
  };
  const find = (ref) => {
    ensure(ref);
    let root = ref;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(ref) !== ref) {
      const next = parent.get(ref);
      parent.set(ref, root);
      ref = next;
    }
    return root;
  };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };

  for (const [issue, prs] of candidates) {
    if (prs.size !== 1) continue;
    const [pr] = prs;
    ensure(issue);
    ensure(pr);
    union(issue, pr);
  }

  const aliases = new Map();
  for (const ref of parent.keys()) aliases.set(ref, find(ref));
  return aliases;
}

export function ambiguousReferences(commits) {
  const candidates = new Map();
  for (const commit of commits ?? []) {
    const refs = commit?.refs ?? commitReferences(commit?.subject);
    if (refs.length < 2) continue;
    const pr = refs.at(-1);
    for (const issue of refs.slice(0, -1)) {
      if (issue === pr) continue;
      if (!candidates.has(issue)) candidates.set(issue, new Set());
      candidates.get(issue).add(pr);
    }
  }
  return new Set([...candidates].filter(([, prs]) => prs.size > 1).map(([issue]) => issue));
}

export function canonicalReference(ref, aliases = new Map()) {
  return aliases.get(ref) ?? ref;
}

export function coveredByReferences(refs, covered, aliases = new Map(), ambiguous = new Set()) {
  const coveredKeys = new Set(
    [...covered].filter((ref) => !ambiguous.has(ref)).map((ref) => canonicalReference(ref, aliases)),
  );
  return refs.some(
    (ref) => !ambiguous.has(ref) && coveredKeys.has(canonicalReference(ref, aliases)),
  );
}

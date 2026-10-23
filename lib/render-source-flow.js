/**
 * The terminal and `--html` rendering of the source-flow projection.
 *
 * Everything here reads the `sourceFlow` object and nothing else — not the walk, not the
 * facts — so the terminal text, the HTML page and the JSON answer cannot disagree about
 * what the projection said. `sourceFlowLines` returns one record per printed line, with the
 * projection step behind it, which is what the page uses to link a line to its evidence.
 */
import { internals } from './render-tree.js';

const { plural } = internals;

export const SOURCE_FLOW_LABEL =
  'source-flow view: calls at their call sites, in the order the source supports (static evidence)';
export const DEPENDENCY_LABEL =
  'dependency view: calls grouped by callee, not in call order (--view source-flow shows call order)';

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
};

function painter(enabled) {
  if (!enabled) return (text) => text;
  return (text, color) => `${COLORS[color] || ''}${text}${COLORS.reset}`;
}

function siteText(site) {
  if (!site || !site.file) return '-';
  return Number.isInteger(site.column) ? `${site.file}:${site.line}:${site.column}` : `${site.file}:${site.line}`;
}

function declarationText(declaration) {
  if (!declaration) return '-';
  const where = declaration.file ? `${declaration.file}${declaration.line ? `:${declaration.line}` : ''}` : '-';
  return `${declaration.ref}  ${declaration.repo}  ${where}`;
}

/** Every invocation in the projection, keyed by id, for back-references and join locals. */
function indexInvocations(sourceFlow) {
  const byId = new Map();
  const visit = (steps) => {
    for (const step of steps || []) {
      if (step.kind === 'invocation') {
        byId.set(step.id, step);
        if (step.target && step.target.body) visit(step.target.body.steps);
        for (const continuation of step.continuations || []) visit(continuation.steps);
        continue;
      }
      if (step.kind === 'branch') step.arms.forEach((arm) => visit(arm.steps));
      else if (step.kind === 'try') {
        visit(step.body);
        step.catches.forEach((entry) => visit(entry.steps));
        visit(step.finally);
      } else if (Array.isArray(step.steps)) visit(step.steps);
    }
  };
  if (sourceFlow.root && sourceFlow.root.body) visit(sourceFlow.root.body.steps);
  return byId;
}

function invocationMarks(step, byId) {
  const marks = [];
  if (step.await) marks.push('await');
  if (step.task) {
    if (step.task.join) marks.push(`launch ${step.task.local || '-'}`);
    else marks.push('launched, not joined');
  }
  if (step.infra && step.hidden) {
    marks.push(`infrastructure: ${plural(step.hidden.invocations, 'invocation')}, ${plural(step.hidden.stops, 'walk stop')} hidden (use --expand-infra)`);
  }
  if (step.target && step.target.stop) marks.push(`stop: ${step.target.stop}`);
  if (step.target && step.target.targets) {
    marks.push(`${plural(step.target.targets.length, 'target')} in run order (${step.target.order})`);
  }
  if (step.target && step.target.see) {
    const shown = byId.get(step.target.see);
    const at = shown ? siteText(shown.site) : 'earlier';
    marks.push(step.target.reason === 'recursion' ? `↺ ${step.declaration ? step.declaration.ref : ''} (recursion, active at ${at})` : `↑ ${step.declaration ? step.declaration.ref : ''} (body shown at ${at})`);
  }
  return marks;
}

function invocationText(step, byId) {
  const via = step.via ? `  [${step.via}]` : '';
  const marks = invocationMarks(step, byId);
  const suffix = marks.length > 0 ? `  ${marks.join('  ')}` : '';
  return `${siteText(step.site)} → ${declarationText(step.declaration)}${via}${suffix}`;
}

/**
 * One record per printed line. `step` is the projection step the line draws, so a caller can
 * bind a line to its evidence without re-deriving which step printed it.
 */
export function sourceFlowLines(sourceFlow) {
  const byId = indexInvocations(sourceFlow);
  const lines = [];

  const emit = (text, step = null) => lines.push({ text, step });

  const walk = (steps, prefix) => {
    (steps || []).forEach((step, position) => {
      const last = position === steps.length - 1;
      const connector = prefix === null ? '' : `${prefix}${last ? '└─ ' : '├─ '}`;
      const childPrefix = prefix === null ? '' : `${prefix}${last ? '   ' : '│  '}`;
      renderStep(step, connector, childPrefix);
    });
  };
  const renderStep = (step, connector, childPrefix) => {
    if (step.kind === 'invocation') {
      emit(`${connector}${invocationText(step, byId)}`, step);
      if (step.target && step.target.body) walk(step.target.body.steps, childPrefix);
      if (step.target && step.target.targets) {
        step.target.targets.forEach((hop, index) => {
          emit(`${childPrefix}${index + 1}. ${declarationText(hop.declaration)}`, step);
        });
      }
      for (const continuation of step.continuations || []) {
        const outcome = `${continuation.outcome} continuation at ${siteText(continuation.site)}`;
        emit(`${childPrefix}↳ ${outcome}`, step);
        walk(continuation.steps, `${childPrefix}   `);
      }
      return;
    }
    if (step.kind === 'branch') {
      emit(`${connector}${siteText(step.site)}  ◇ ${step.text || step.form}`, step);
      step.arms.forEach((arm, index) => {
        const lastArm = index === step.arms.length - 1;
        emit(`${childPrefix}${lastArm ? '└─ ' : '├─ '} ${arm.arm}`, step);
        walk(arm.steps, `${childPrefix}${lastArm ? '   ' : '│  '}`);
      });
      return;
    }
    if (step.kind === 'try') {
      emit(`${connector}${siteText(step.site)}  ◇ try`, step);
      walk(step.body, childPrefix);
      step.catches.forEach((entry) => {
        emit(`${childPrefix}◇ ${entry.part}`, step);
        walk(entry.steps, `${childPrefix}   `);
      });
      if (step.finally.length > 0) {
        emit(`${childPrefix}◇ finally`, step);
        walk(step.finally, `${childPrefix}   `);
      }
      return;
    }
    if (step.kind === 'loop') {
      emit(`${connector}${siteText(step.site)}  ↻ ${step.text || step.form}  repeatable, no iteration count`, step);
      walk(step.steps, childPrefix);
      return;
    }
    if (step.kind === 'callback') {
      emit(`${connector}${siteText(step.site)}  ⌁ callback ${step.form} to ${step.host || '-'}  scheduling unknown`, step);
      walk(step.steps, childPrefix);
      return;
    }
    if (step.kind === 'join') {
      const locals = (step.tasks || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((invocation) => (invocation.task && invocation.task.local) || invocation.id)
        .join(', ');
      emit(`${connector}${siteText(step.site)}  ⋈ ${step.form}${locals ? ` (${locals})` : ''}`, step);
      return;
    }
    if (step.kind === 'unordered') {
      const detail = step.form || step.detail;
      emit(`${connector}${step.sites && step.sites.length > 0 ? `${siteText(step.sites[0])}  ` : ''}? order unknown: ${step.reason}${detail ? ` (${detail})` : ''}`, step);
      walk(step.steps, childPrefix);
      return;
    }
    // A hop: a node the walk reached that no call fact placed in this body.
    emit(`${connector}${siteText(step.site)} → ${declarationText(step.declaration)}${step.order ? `  ${plural(step.targets.length, 'target')} in run order (${step.order})` : ''}`, step);
    for (const [index, hop] of (step.targets || []).entries()) {
      emit(`${childPrefix}${index + 1}. ${declarationText(hop.declaration)}`, step);
    }
    if (step.body) walk(step.body.steps, childPrefix);
  };

  if (sourceFlow.root && sourceFlow.root.body) walk(sourceFlow.root.body.steps, null);
  return lines;
}

/** The trailer: what the projection counted, and whether the walk ran out of budget. */
export function renderSourceFlowTrailer(sourceFlow) {
  const counts = sourceFlow.counts || { bodies: 0, invocations: 0, unordered: 0, frontier: 0 };
  const parts = [
    `${plural(counts.invocations, 'invocation')} in ${counts.bodies} ${counts.bodies === 1 ? 'body' : 'bodies'}`,
  ];
  const unordered = reasonCounts(sourceFlow, 'unordered');
  parts.push(`${plural(counts.unordered, 'unknown-order group')}${unordered.size > 0 ? ` (${[...unordered].map(([reason, count]) => `${reason} ${count}`).join(', ')})` : ''}`);
  const stops = reasonCounts(sourceFlow, 'stop');
  parts.push(`${plural(counts.frontier, 'walk stop')}${stops.size > 0 ? ` (${[...stops].map(([reason, count]) => `${reason} ${count}`).join(', ')})` : ''}`);
  if (sourceFlow.walk && sourceFlow.walk.budgetHit) parts.push('node budget reached');
  return `source flow: ${parts.join(' · ')}`;
}

function reasonCounts(sourceFlow, kind) {
  const counts = new Map();
  const visit = (steps) => {
    for (const step of steps || []) {
      if (kind === 'unordered' && step.kind === 'unordered') counts.set(step.reason, (counts.get(step.reason) || 0) + 1);
      if (kind === 'stop' && step.kind === 'invocation' && step.target && step.target.stop) {
        counts.set(step.target.stop, (counts.get(step.target.stop) || 0) + 1);
      }
      if (step.kind === 'branch') step.arms.forEach((arm) => visit(arm.steps));
      else if (step.kind === 'try') {
        visit(step.body);
        step.catches.forEach((entry) => visit(entry.steps));
        visit(step.finally);
      } else if (Array.isArray(step.steps)) visit(step.steps);
    }
  };
  if (sourceFlow.root && sourceFlow.root.body) visit(sourceFlow.root.body.steps);
  return counts;
}

/** The whole block: the label line, the tree, and the trailer. */
export function renderSourceFlow(sourceFlow, { color = false } = {}) {
  const paint = painter(color);
  const lines = [paint(SOURCE_FLOW_LABEL, 'dim')];
  for (const line of sourceFlowLines(sourceFlow)) lines.push(line.text);
  lines.push('');
  lines.push(paint(renderSourceFlowTrailer(sourceFlow), 'dim'));
  return lines.join('\n');
}

/** The plain text of the tree under the label, which the `--html` page must carry unchanged. */
export function sourceFlowTreeText(sourceFlow) {
  return sourceFlowLines(sourceFlow)
    .map((line) => line.text)
    .join('\n');
}

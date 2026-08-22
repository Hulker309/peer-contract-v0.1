// src/lib/reporter.js
// Output formatting for CLI commands.

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function isColorEnabled() {
  // Disable colors if not a TTY or NO_COLOR is set
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY;
}

function colorize(text, color) {
  if (!isColorEnabled()) return text;
  return `${colors[color]}${text}${colors.reset}`;
}

function formatCheckResult(result) {
  const lines = [];
  if (result.ok) {
    lines.push(colorize('OK', 'green') + ' envelope valid');
  } else {
    lines.push(colorize('BLOCK', 'red') + ` envelope invalid (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})`);
    for (const err of result.errors) {
      lines.push(`  ${colorize('×', 'red')} ${err.path}: ${err.message}`);
    }
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push(colorize('WARN', 'yellow') + ` ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`);
    for (const w of result.warnings) {
      lines.push(`  ${colorize('!', 'yellow')} ${w}`);
    }
  }
  if (result.sizeBytes !== undefined) {
    lines.push(`  size: ${result.sizeBytes} / ${result.sizeLimit} bytes ${result.sizeBytes <= result.sizeLimit ? '✓' : '✗'}`);
  }
  return lines.join('\n');
}

function formatDryRunStep(step, result) {
  const lines = [];
  const status = result.ok ? colorize('OK', 'green') : colorize('BLOCK', 'red');
  const reason = result.reason ? colorize(` (${result.reason})`, 'gray') : '';
  lines.push(`  [${step.number}/${step.total}] ${status} ${step.label}${reason}`);
  if (result.detail) {
    lines.push(`      ${colorize(result.detail, 'gray')}`);
  }
  return lines.join('\n');
}

function formatDryRunSummary(steps, results) {
  const okCount = results.filter(r => r.ok).length;
  const blockCount = results.length - okCount;
  const lines = [];
  lines.push('');
  lines.push(colorize('=== Dry-run summary ===', 'bold'));
  lines.push(`Total steps: ${results.length}`);
  lines.push(`${colorize('OK', 'green')}: ${okCount}`);
  lines.push(`${colorize('BLOCK', 'red')}: ${blockCount}`);
  if (blockCount === 0) {
    lines.push(colorize('End-to-end: PASS', 'green'));
  } else {
    lines.push(colorize('End-to-end: FAIL', 'red'));
  }
  return lines.join('\n');
}

module.exports = {
  colors,
  colorize,
  formatCheckResult,
  formatDryRunStep,
  formatDryRunSummary,
  isColorEnabled,
};

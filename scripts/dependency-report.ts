import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const severity = z.enum(['info', 'low', 'moderate', 'high', 'critical']);
const reportSchema = z.object({
  advisories: z.record(
    z.string(),
    z.object({
      module_name: z.string(),
      severity,
      url: z.url().startsWith('https://github.com/advisories/'),
    }),
  ),
  metadata: z.object({ vulnerabilities: z.record(severity, z.number().int().nonnegative()) }),
  error: z.never().optional(),
});

// Findings are report data. Missing, malformed, or failed scans must still fail the job.
export function dependencyReport(stdout: string, status: number | null): string {
  const report = reportSchema.parse(JSON.parse(stdout));
  const advisories = Object.values(report.advisories);
  if (status !== 0 && (status !== 1 || advisories.length === 0))
    throw new Error('Dependency audit did not complete successfully.');
  const escape = (value: string) =>
    value
      .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
      .replace(/[\\`*_[\]|]/g, '\\$&')
      .replace(/[\r\n]/g, ' ');
  return [
    '## Dependency advisory report',
    '',
    'This scheduled report is independent of build verification. Findings require review; a successful job means the scan completed.',
    '',
    ...Object.entries(report.metadata.vulnerabilities).map(
      ([level, count]) => `- ${level}: ${count}`,
    ),
    '',
    '| Package | Severity | Advisory |',
    '| --- | --- | --- |',
    ...advisories.map(
      (a) =>
        `| ${escape(a.module_name)} | ${a.severity} | [Details](${encodeURI(a.url).replaceAll(')', '%29')}) |`,
    ),
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync('pnpm', ['audit', '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const summary = dependencyReport(result.stdout, result.status);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

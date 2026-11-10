#!/usr/bin/env node
// Release scope guard: NexDrop TV is excluded from this pipeline by owner decision.
// Fails closed if ANY workflow builds, packages, uploads or releases :tv / NexDropTV.
import { readFileSync, readdirSync } from 'node:fs';
const dir = '.github/workflows';
const problems = [];
for (const f of readdirSync(dir)) {
  if (!/\.ya?ml$/.test(f)) continue;
  const yml = readFileSync(`${dir}/${f}`, 'utf8');
  if (/:tv:/.test(yml)) problems.push(`${f}: references a :tv Gradle task`);
  if (/NexDropTV/i.test(yml)) problems.push(`${f}: references a NexDropTV artifact`);
  if (/android\/tv\//.test(yml)) problems.push(`${f}: references the android/tv module`);
}
const rel = readFileSync(`${dir}/android-build.yml`, 'utf8');
if (!/:app:assembleRelease/.test(rel)) problems.push('android-build.yml no longer builds :app:assembleRelease');
for (const p of problems) console.error(`FAIL ${p}`);
console.log(problems.length ? `[scope] ${problems.length} problem(s)` : '[scope] release pipeline is :app-only');
process.exit(problems.length ? 1 : 0);

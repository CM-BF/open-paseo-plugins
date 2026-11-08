// Opt-in isolated protocol acceptance. Starts only an owned loopback sshd; never reads ~/.ssh.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { initializeApp } from './scaffold.mjs';
import { readJson, writeJson, digest } from './files.mjs';
import { createSshPlan, runSsh, shellQuote } from './ssh.mjs';

const suppliedOutput = process.argv[2];
if (!suppliedOutput || !path.isAbsolute(suppliedOutput)) throw new Error('Pass a new absolute evidence directory');
await fs.mkdir(suppliedOutput, { mode: 0o700 });
const root = await fs.realpath(suppliedOutput);
const receipt = { status: 'running', root, checks: [], ownedSshd: null, primaryDaemonTouched: false, workComputerAccessed: false, realSsh: true };
const receiptFile = path.join(root, 'receipt.json');
const record = async () => fs.writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
let sshd, sshdLog, sshdExited = false, deployedPlan;
const keys = ['client-key', 'host-key'];
const execute = (program, args, input) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); child.stdin.end(input);
});
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const parsed = result => JSON.parse(result.output);
try {
  for (const key of keys) {
    const generated = await execute('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', path.join(root, key)]);
    demand(generated.code === 0, 'Could not create an isolated SSH test key');
  }
  await fs.copyFile(path.join(root, 'client-key.pub'), path.join(root, 'authorized_keys')); await fs.chmod(path.join(root, 'authorized_keys'), 0o600);
  const temporaryListener = net.createServer(); temporaryListener.listen(0, '127.0.0.1'); await once(temporaryListener, 'listening'); const port = temporaryListener.address().port; await new Promise(resolve => temporaryListener.close(resolve));
  const config = path.join(root, 'sshd_config'), sshConfig = path.join(root, 'ssh_config'), wrapper = path.join(root, 'owned-ssh');
  const sshdText = `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${path.join(root, 'host-key')}\nPidFile ${path.join(root, 'sshd.pid')}\nAuthorizedKeysFile ${path.join(root, 'authorized_keys')}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nAllowUsers ${os.userInfo().username}\nStrictModes yes\nUseDNS no\nLogLevel VERBOSE\n`;
  await fs.writeFile(config, sshdText, { mode: 0o600 });
  const publicHostKey = (await fs.readFile(path.join(root, 'host-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  const knownHosts = path.join(root, 'known_hosts'); await fs.writeFile(knownHosts, `[127.0.0.1]:${port} ${publicHostKey}\n`, { mode: 0o600 });
  await fs.writeFile(sshConfig, `Host board-protocol-test\n HostName 127.0.0.1\n Port ${port}\n User ${os.userInfo().username}\n IdentityFile ${path.join(root, 'client-key')}\n IdentitiesOnly yes\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n StrictHostKeyChecking yes\n BatchMode yes\n`, { mode: 0o600 });
  await fs.writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/ssh -F ${shellQuote(sshConfig)} "$@"\n`, { mode: 0o700 });
  const checked = await execute('/usr/sbin/sshd', ['-t', '-f', config]);
  await fs.writeFile(path.join(root, 'sshd-preflight.log'), checked.stderr); demand(checked.code === 0, 'Isolated sshd configuration rejected; see sshd-preflight.log');
  sshdLog = await fs.open(path.join(root, 'sshd.log'), 'a', 0o600);
  sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', sshdLog.fd, sshdLog.fd] });
  receipt.ownedSshd = { pid: sshd.pid, port, config }; sshd.once('exit', () => { sshdExited = true; }); await record();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (sshdExited) throw new Error('Owned sshd exited before listening; see sshd.log');
    const listening = await new Promise(resolve => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (listening) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const version = await execute('/usr/bin/ssh', ['-F', sshConfig, 'board-protocol-test', `${shellQuote(process.execPath)} --version`]);
  await fs.writeFile(path.join(root, 'ssh-handshake.log'), JSON.stringify(version)); demand(version.code === 0, 'Real SSH authentication failed; see ssh-handshake.log'); receipt.checks.push('real-public-key-ssh-handshake');
  const source = path.join(root, 'source'); await initializeApp(source, 'protocol-test');
  const appConfig = await readJson(path.join(source, 'board-app.json')); appConfig.port = 0; appConfig.comments.enabled = true; await fs.writeFile(path.join(source, 'board-app.json'), JSON.stringify(appConfig));
  const planFile = path.join(root, 'deploy-plan.json'), plan = await createSshPlan({ dir: source, host: 'board-protocol-test', root: path.join(root, 'remote'), node: process.execPath, out: planFile });
  const invoke = (operation, active = deployedPlan) => runSsh(operation, { plan: active.file, confirm: active.sha256 }, { executable: wrapper });
  deployedPlan = { file: planFile, sha256: plan.sha256 };
  let result = parsed(await invoke('deploy')); receipt.checks.push('actual-ssh-reviewed-deploy-and-health');
  const deploymentId = result.health.deploymentId;
  const response = await fetch(`http://127.0.0.1:${result.health.port}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Across real SSH' }) }); demand(response.status === 201, 'Deployed HTTP route failed');
  const backup = parsed(await invoke('backup')); demand(backup.sha256 && backup.sha256 === digest(await fs.readFile(backup.file)), 'Remote backup digest mismatch'); receipt.checks.push('actual-ssh-backup-matches-durable-data');
  await fs.appendFile(path.join(source, 'routes.mjs'), '\n// edited after deployment');
  result = parsed(await invoke('status')); demand(result.status === 'running', 'Original plan no longer controls app after source edit');
  await invoke('stop'); result = parsed(await invoke('start')); demand(result.health.deploymentId === deploymentId, 'Restart changed deployment identity'); receipt.checks.push('actual-ssh-status-stop-start-after-local-edit');
  const secondFile = path.join(root, 'deploy-plan-2.json'), second = await createSshPlan({ dir: source, host: 'board-protocol-test', root: path.join(root, 'remote'), node: process.execPath, out: secondFile });
  deployedPlan = { file: secondFile, sha256: second.sha256 }; result = parsed(await invoke('deploy'));
  demand(result.health.deploymentId === deploymentId, 'Redeploy changed deployment identity');
  const rows = await fetch(`http://127.0.0.1:${result.health.port}/api/records`).then(r => r.json()); demand(rows.records[0]?.title === 'Across real SSH', 'Redeploy lost application data'); receipt.checks.push('actual-ssh-redeploy-preserves-data-and-identity');
  const logs = parsed(await invoke('logs')); demand(logs.logs.includes('listening'), 'Remote logs missing actual startup');
  await invoke('stop'); result = parsed(await invoke('status')); demand(result.status === 'stopped', 'App did not stop'); receipt.checks.push('actual-ssh-logs-and-final-app-stop');
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed-preserved-for-reconciliation'; receipt.error = error.message; process.exitCode = 1; }
finally {
  if (deployedPlan && sshd && !sshdExited) {
    try { const result = await runSsh('stop', { plan: deployedPlan.file, confirm: deployedPlan.sha256 }, { executable: path.join(root, 'owned-ssh') }); receipt.appCleanup = parsed(result); }
    catch (error) { receipt.appCleanup = { error: error.message }; receipt.status = 'failed-cleanup-reconciliation-required'; process.exitCode = 1; }
  }
  if (sshd && !sshdExited) { const exit = once(sshd, 'exit'); sshd.kill('SIGTERM'); await exit; }
  await sshdLog?.close(); receipt.sshdStopped = !sshd || sshdExited;
  for (const key of keys) await fs.rm(path.join(root, key), { force: true });
  receipt.temporaryPrivateKeysRemoved = true; await record();
}
console.log(JSON.stringify({ status: receipt.status, receipt: receiptFile, checks: receipt.checks.length, error: receipt.error || null }));

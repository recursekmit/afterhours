// Word pools per level (A-Z only). Tech and club flavoured. Lengths must fit LADDER.
// Pools are big (40+) so that neighbours playing the same level at the same moment, even a whole room
// in a speed round, get different words (see pickWord in index.ts).
import { LADDER, normaliseWord } from '@afterhours/shared/features/morse';

export const WORDS: Record<number, string[]> = {
  1: [
    'hi', 'bug', 'git', 'ssh', 'cpu', 'ram', 'web', 'npm', 'css', 'vim', 'app', 'bit', 'key', 'sql', 'api', 'ide', 'tab', 'run', 'fix', 'dev', 'png', 'pdf', 'gif', 'tea',
    'usb', 'lan', 'hex', 'bin', 'log', 'zip', 'tar', 'jar', 'bot', 'net', 'gpu', 'rom', 'dns', 'tcp', 'udp', 'xor', 'ai', 'os', 'io', 'ui', 'pc', 'cd', 'ls', 'url', 'cli', 'sdk',
  ],
  2: [
    'code', 'byte', 'ping', 'node', 'java', 'wifi', 'hack', 'tmux', 'grep', 'bash', 'rust', 'dart', 'loop', 'sudo', 'exit', 'null', 'kmit', 'chai', 'demo', 'repo', 'fork', 'push', 'pull', 'port', 'void',
    'hash', 'heap', 'tree', 'enum', 'char', 'bool', 'host', 'root', 'json', 'yaml', 'html', 'http', 'diff', 'lint', 'test', 'mock', 'data', 'disk', 'chip', 'core', 'boot', 'link', 'pipe', 'file', 'path',
  ],
  3: [
    'debug', 'linux', 'stack', 'array', 'cloud', 'merge', 'regex', 'admin', 'pixel', 'token', 'cache', 'async', 'macro', 'patch', 'shell', 'swift', 'agile', 'login', 'proxy', 'query', 'class', 'chess', 'pizza', 'ready', 'build',
    'queue', 'tuple', 'layer', 'modem', 'radix', 'shard', 'virus', 'logic', 'bytes', 'mutex', 'float', 'index', 'event', 'scope', 'fetch', 'yield', 'parse', 'route', 'frame', 'graph', 'react', 'spark', 'robot', 'laser', 'solar',
  ],
  4: [
    'commit', 'python', 'docker', 'kernel', 'server', 'branch', 'syntax', 'signal', 'cipher', 'socket', 'buffer', 'script', 'client', 'router', 'github', 'coffee', 'laptop', 'binary', 'thread', 'module', 'hunter', 'secret',
    'cursor', 'packet', 'vector', 'object', 'string', 'lambda', 'kotlin', 'widget', 'tensor', 'plugin', 'hacker', 'sensor', 'bitmap', 'driver', 'format', 'backup', 'upload', 'output', 'memory', 'random', 'search', 'editor', 'engine', 'pixels',
  ],
  5: [
    ...['recurse', 'hackers', 'compile', 'network', 'backend', 'deploy', 'machine', 'frontend', 'protocol', 'firewall', 'terminal', 'hardware', 'keyboard', 'morsecode', 'algorithm', 'database', 'function', 'variable', 'platform', 'telegram'].filter((w) => w.length >= 7),
    'compiler', 'debugger', 'internet', 'software', 'computer', 'interface', 'recursion', 'processor', 'bandwidth', 'framework', 'developer', 'bluetooth', 'benchmark', 'container', 'semicolon', 'hackathon', 'telegraph', 'overflow',
    'quantum', 'android', 'circuit', 'monitor', 'gateway', 'runtime', 'browser', 'storage', 'library', 'package', 'program', 'cluster',
  ],
};

/** Fails loudly at import time if a pool breaks the ladder (so a typo is caught by the first test run). */
export function validateWords(): void {
  for (const def of LADDER) {
    const pool = WORDS[def.level];
    if (!pool || pool.length < 12) throw new Error(`Level ${def.level} needs at least 12 words`);
    if (new Set(pool).size !== pool.length) throw new Error(`Level ${def.level} has a word twice`);
    for (const w of pool) {
      if (w !== normaliseWord(w).toLowerCase()) throw new Error(`Bad word "${w}"`);
      if (w.length < def.minLen || w.length > def.maxLen) throw new Error(`"${w}" does not fit level ${def.level}`);
    }
  }
}
validateWords();

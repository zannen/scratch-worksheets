// Headless browsers for the end-to-end test, with the same small interface:
//
//     const browser = await launch('chromium');   // or 'firefox'
//     const page = await browser.open(url);
//     await page.evaluate('document.title');      // any JSON-serialisable result
//     const pdf = await page.print();              // a Buffer, printed on A4
//     const png = await page.screenshot();         // a Buffer, of the whole page
//     await page.close();
//     await browser.close();
//
// Chromium is driven over the Chrome DevTools Protocol. Firefox is driven over
// WebDriver BiDi, through geckodriver (which also gives Firefox a fresh profile).

import {spawn} from 'node:child_process';

export const BROWSERS = ['chromium', 'firefox'];

export function launch(name) {
  if (name === 'chromium') {
    return Chromium.launch(process.env.CHROMIUM || 'chromium');
  }
  if (name === 'firefox') {
    return Firefox.launch(process.env.GECKODRIVER || 'geckodriver', process.env.FIREFOX);
  }
  throw new Error(`unknown browser ${name}: use one of ${BROWSERS.join(', ')}`);
}

/** Run a program until it prints a line matching pattern; resolve with the match. */
function start(command, args, pattern) {
  const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${command} did not start\n${output}`)), 30_000);
    const read = data => {
      output += data;
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve({child, match});
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', error => reject(new Error(`could not run ${command}: ${error.message}`)));
    child.on('exit', code => reject(new Error(`${command} exited (${code})\n${output}`)));
  });
}

/** A JSON-over-WebSocket connection, matching each reply to its command by id. */
class Connection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending(message);
      }
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve);
      this.socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)));
    });
  }

  send(command) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({id, ...command}));
    return new Promise(resolve => this.pending.set(id, resolve));
  }

  close() {
    this.socket.close();
  }
}

/** Wrap an expression so it gives a JSON string, whatever the protocol. */
const asJson = expression => `(async () => JSON.stringify(await (${expression})))()`;
const fromJson = text => (text === undefined ? undefined : JSON.parse(text));

// A4, in centimetres.
const A4 = {width: 21, height: 29.7};

class Chromium {
  static async launch(command) {
    const {child, match} = await start(command, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', 'about:blank',
    ], /DevTools listening on (ws:\S+)/);
    const connection = new Connection(match[1]);
    await connection.opened;
    return new Chromium(child, connection);
  }

  constructor(child, connection) {
    this.name = 'chromium';
    this.child = child;
    this.connection = connection;
  }

  async send(method, params = {}, sessionId = undefined) {
    const reply = await this.connection.send({method, params, sessionId});
    if (reply.error) {
      throw new Error(`${method}: ${reply.error.message}`);
    }
    return reply.result;
  }

  async open(url) {
    const {targetId} = await this.send('Target.createTarget', {url});
    const {sessionId} = await this.send('Target.attachToTarget', {targetId, flatten: true});
    return {
      evaluate: async expression => {
        const {result, exceptionDetails} = await this.send(
          'Runtime.evaluate', {expression: asJson(expression), awaitPromise: true, returnByValue: true}, sessionId);
        if (exceptionDetails) {
          throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        }
        return fromJson(result.value);
      },
      print: async () => {
        const {data} = await this.send('Page.printToPDF', {preferCSSPageSize: true, printBackground: true}, sessionId);
        return Buffer.from(data, 'base64');
      },
      screenshot: async () => {
        const {data} = await this.send('Page.captureScreenshot', {captureBeyondViewport: true}, sessionId);
        return Buffer.from(data, 'base64');
      },
      close: () => this.send('Target.closeTarget', {targetId}),
    };
  }

  async close() {
    this.connection.close();
    this.child.kill();
  }
}

class Firefox {
  static async launch(command, binary) {
    const {child, match} = await start(command, ['--port', '0'], /Listening on (\S+:\d+)/);
    const base = `http://${match[1]}`;
    const options = {args: ['-headless']};
    if (binary) {
      options.binary = binary;
    }
    const response = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({capabilities: {alwaysMatch: {
        browserName: 'firefox', webSocketUrl: true, 'moz:firefoxOptions': options,
      }}}),
    });
    const {value} = await response.json();
    if (!response.ok) {
      child.kill();
      throw new Error(`geckodriver could not start Firefox: ${value.message}`);
    }
    const connection = new Connection(value.capabilities.webSocketUrl);
    await connection.opened;
    return new Firefox(child, base, value.sessionId, connection);
  }

  constructor(child, base, sessionId, connection) {
    this.name = 'firefox';
    this.child = child;
    this.base = base;
    this.sessionId = sessionId;
    this.connection = connection;
  }

  async send(method, params = {}) {
    const reply = await this.connection.send({method, params});
    if (reply.type === 'error') {
      throw new Error(`${method}: ${reply.error}: ${reply.message}`);
    }
    return reply.result;
  }

  async open(url) {
    const {context} = await this.send('browsingContext.create', {type: 'tab'});
    await this.send('browsingContext.navigate', {context, url, wait: 'complete'});
    return {
      evaluate: async expression => {
        const result = await this.send('script.evaluate', {
          expression: asJson(expression), target: {context}, awaitPromise: true,
        });
        if (result.type === 'exception') {
          throw new Error(result.exceptionDetails.text);
        }
        return fromJson(result.result.value);
      },
      print: async () => {
        const {data} = await this.send('browsingContext.print', {
          context, background: true, page: A4, margin: {top: 0, bottom: 0, left: 0, right: 0},
        });
        return Buffer.from(data, 'base64');
      },
      screenshot: async () => {
        const {data} = await this.send('browsingContext.captureScreenshot', {context, origin: 'document'});
        return Buffer.from(data, 'base64');
      },
      close: () => this.send('browsingContext.close', {context}),
    };
  }

  async close() {
    this.connection.close();
    await fetch(`${this.base}/session/${this.sessionId}`, {method: 'DELETE'}).catch(() => {});
    this.child.kill();
  }
}

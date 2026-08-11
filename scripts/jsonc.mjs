export function parseJsonc(source, sourcePath = '<jsonc>') {
  try {
    return new JsoncParser(source).parse();
  } catch (error) {
    throw new Error(
      `Cannot parse ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

class JsoncParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.depth = 0;
  }

  parse() {
    const value = this.parseValue('$');
    this.skipIgnored();
    if (this.index !== this.source.length) this.fail('unexpected trailing input');
    return value;
  }

  parseValue(location) {
    this.skipIgnored();
    const character = this.source[this.index];
    if (character === '{') return this.parseObject(location);
    if (character === '[') return this.parseArray(location);
    if (character === '"') return this.parseString();
    if (this.source.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.source.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.source.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    if (character === '-' || /[0-9]/.test(character ?? '')) return this.parseNumber();
    this.fail(`expected a JSON value at ${location}`);
  }

  parseObject(location) {
    this.enterComposite(location);
    this.index += 1;
    const value = Object.create(null);
    const keys = new Set();
    this.skipIgnored();
    if (this.consume('}')) {
      this.leaveComposite();
      return value;
    }
    while (true) {
      this.skipIgnored();
      if (this.source[this.index] !== '"') this.fail(`expected a quoted key at ${location}`);
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate key ${JSON.stringify(key)} at ${location}`);
      keys.add(key);
      this.skipIgnored();
      if (!this.consume(':')) this.fail(`expected ':' after ${JSON.stringify(key)}`);
      value[key] = this.parseValue(`${location}.${key}`);
      this.skipIgnored();
      if (this.consume('}')) {
        this.leaveComposite();
        return value;
      }
      if (!this.consume(',')) this.fail(`expected ',' or '}' at ${location}`);
      this.skipIgnored();
      if (this.consume('}')) {
        this.leaveComposite();
        return value;
      }
    }
  }

  parseArray(location) {
    this.enterComposite(location);
    this.index += 1;
    const value = [];
    this.skipIgnored();
    if (this.consume(']')) {
      this.leaveComposite();
      return value;
    }
    while (true) {
      value.push(this.parseValue(`${location}[${value.length}]`));
      this.skipIgnored();
      if (this.consume(']')) {
        this.leaveComposite();
        return value;
      }
      if (!this.consume(',')) this.fail(`expected ',' or ']' at ${location}`);
      this.skipIgnored();
      if (this.consume(']')) {
        this.leaveComposite();
        return value;
      }
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (character === '"') {
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch (error) {
          this.fail(
            `invalid JSON string: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (character === '\n' || character === '\r') this.fail('unescaped newline in string');
    }
    this.fail('unterminated JSON string');
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.index),
    );
    if (match === null) this.fail('invalid JSON number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('JSON number is outside the supported range');
    return value;
  }

  skipIgnored() {
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (/\s/.test(character)) {
        this.index += 1;
        continue;
      }
      if (character !== '/' || this.source[this.index + 1] === undefined) return;
      const next = this.source[this.index + 1];
      if (next === '/') {
        this.index += 2;
        while (
          this.index < this.source.length &&
          this.source[this.index] !== '\n' &&
          this.source[this.index] !== '\r'
        ) {
          this.index += 1;
        }
        continue;
      }
      if (next === '*') {
        const end = this.source.indexOf('*/', this.index + 2);
        if (end < 0) this.fail('unterminated block comment');
        this.index = end + 2;
        continue;
      }
      return;
    }
  }

  enterComposite(location) {
    this.depth += 1;
    if (this.depth > 64) this.fail(`JSON nesting exceeds the limit at ${location}`);
  }

  leaveComposite() {
    this.depth -= 1;
  }

  consume(character) {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  fail(message) {
    throw new Error(`${message} near byte ${this.index}`);
  }
}

/**
 * Exact arithmetic for checking numbers.
 *
 * A small recursive-descent parser: numbers, + - * / ^ %, parentheses and unary
 * minus. It never evaluates code — anything it does not recognise is an error.
 * Agents that show their arithmetic are checked against it by the judge.
 */

export class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorError';
  }
}

const MAX_LENGTH = 400;

export function evaluate(expression: string): number {
  if (expression.length > MAX_LENGTH) throw new CalculatorError('La expresión es demasiado larga.');
  const source = expression
    .replace(/[−–]/g, '-')
    .replace(/[×xX]/g, '*')
    .replace(/÷/g, '/')
    .replace(/\s+/g, '');
  let pos = 0;

  const peek = (): string | undefined => source[pos];

  function number(): number {
    const start = pos;
    while (pos < source.length && /[\d.]/.test(source[pos]!)) pos += 1;
    const text = source.slice(start, pos);
    if (text === '' || (text.match(/\./g)?.length ?? 0) > 1) throw new CalculatorError(`Símbolo inesperado «${peek() ?? 'fin'}» en la posición ${start}.`);
    return Number(text);
  }

  function primary(): number {
    const c = peek();
    if (c === '(') {
      pos += 1;
      const value = sum();
      if (peek() !== ')') throw new CalculatorError('Falta un paréntesis de cierre.');
      pos += 1;
      return value;
    }
    if (c === '-') {
      pos += 1;
      return -power();
    }
    if (c === '+') {
      pos += 1;
      return power();
    }
    return number();
  }

  function power(): number {
    const base = primary();
    if (peek() === '^') {
      pos += 1;
      return base ** power();
    }
    return base;
  }

  function product(): number {
    let value = power();
    for (;;) {
      const c = peek();
      if (c === '*') {
        pos += 1;
        value *= power();
      } else if (c === '/') {
        pos += 1;
        const divisor = power();
        if (divisor === 0) throw new CalculatorError('División por cero.');
        value /= divisor;
      } else if (c === '%') {
        pos += 1;
        const divisor = power();
        if (divisor === 0) throw new CalculatorError('División por cero.');
        value %= divisor;
      } else return value;
    }
  }

  function sum(): number {
    let value = product();
    for (;;) {
      const c = peek();
      if (c === '+') {
        pos += 1;
        value += product();
      } else if (c === '-') {
        pos += 1;
        value -= product();
      } else return value;
    }
  }

  if (source.length === 0) throw new CalculatorError('La expresión está vacía.');
  const result = sum();
  if (pos < source.length) throw new CalculatorError(`Símbolo inesperado «${source[pos]}» en la posición ${pos}.`);
  if (!Number.isFinite(result)) throw new CalculatorError('El resultado no es un número finito.');
  return result;
}

export interface ArithmeticFinding {
  line: string;
  expression: string;
  claimed: number;
  actual: number;
}

const EQUATION_RE = /(\d[\d.,\s+\-*/×÷^()%−]*[\d)])\s*=\s*\**\s*[€$£]?\s*(-?\d[\d.,]*)/g;

function parseClaimed(raw: string): number | null {
  let s = raw.replace(/[.,]$/, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Find `a op b = c` in text and report the ones whose result is wrong. */
export function findArithmeticErrors(text: string): ArithmeticFinding[] {
  const findings: ArithmeticFinding[] = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(EQUATION_RE)) {
      const expression = match[1]!.trim();
      // Needs an operator, otherwise it is just "x = 5".
      if (!/[+\-*/×÷^%−]/.test(expression.replace(/^-/, ''))) continue;
      const claimed = parseClaimed(match[2]!);
      if (claimed === null) continue;
      let actual: number;
      try {
        actual = evaluate(expression.replace(/(\d),(\d{3})/g, '$1$2'));
      } catch {
        continue;
      }
      const tolerance = Math.max(0.01, Math.abs(actual) * 0.005);
      if (Math.abs(actual - claimed) > tolerance) {
        findings.push({ line: line.trim().slice(0, 240), expression, claimed, actual });
      }
    }
  }
  return findings;
}

export function rollFormula(formula, rand = Math.random) {
  const cleaned = formula.replace(/\s+/g, '');
  return evalExpr(tokenize(cleaned), rand);
}

function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '(' || ch === ')' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < str.length && /[0-9]/.test(str[j])) j++;
      const n = parseInt(str.slice(i, j), 10);
      if (str[j] === 'd' || str[j] === 'D') {
        let k = j + 1;
        while (k < str.length && /[0-9]/.test(str[k])) k++;
        const sides = parseInt(str.slice(j + 1, k), 10);
        tokens.push({ t: 'dice', count: n, sides });
        i = k;
        continue;
      }
      tokens.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (ch === 'd' || ch === 'D') {
      let k = i + 1;
      while (k < str.length && /[0-9]/.test(str[k])) k++;
      const sides = parseInt(str.slice(i + 1, k), 10);
      tokens.push({ t: 'dice', count: 1, sides });
      i = k;
      continue;
    }
    throw new Error(`Unexpected char in dice formula: ${ch}`);
  }
  return tokens;
}

function evalExpr(tokens, rand) {
  let pos = 0;
  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }
  function parsePrimary() {
    const tok = consume();
    if (!tok) throw new Error('Unexpected end of formula');
    if (tok.t === 'op' && tok.v === '(') {
      const v = parseAdd();
      const close = consume();
      if (!close || close.v !== ')') throw new Error('Missing )');
      return v;
    }
    if (tok.t === 'op' && tok.v === '-') {
      return -parsePrimary();
    }
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'dice') {
      let total = 0;
      for (let i = 0; i < tok.count; i++) total += Math.floor(rand() * tok.sides) + 1;
      return total;
    }
    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }
  function parseMul() {
    let left = parsePrimary();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = consume().v;
      const right = parsePrimary();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = consume().v;
      const right = parseMul();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  const result = parseAdd();
  if (pos !== tokens.length) throw new Error('Trailing tokens in formula');
  return result;
}

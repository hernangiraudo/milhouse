use super::context::StepContext;
use anyhow::{anyhow, Result};
use polars::prelude::*;

pub async fn run(
    ctx: &StepContext,
    input: &str,
    filter: Option<&str>,
    select: &[String],
) -> Result<DataFrame> {
    let df = ctx.get_table(input).await?;
    let filter = filter.map(|s| s.to_string());
    let select = select.to_vec();

    let res = tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        let mut lf = df.as_ref().clone().lazy();
        if let Some(expr_str) = &filter {
            let expr = parse_filter(expr_str)?;
            lf = lf.filter(expr);
        }
        if !select.is_empty() {
            let cols: Vec<Expr> = select.iter().map(|c| col(c.as_str())).collect();
            lf = lf.select(cols);
        }
        Ok(lf.collect()?)
    })
    .await??;

    Ok(res)
}

// ---- Mini parser ----
//
// Soporta expresiones tipo:
//   amount > 1000 AND currency == 'USD'
//   score >= 0.5 OR flagged == true
//
// Operadores: ==, !=, >, <, >=, <=, AND, OR.
// Operandos: identificadores, números (int/float), strings 'x' o "x", bool true/false, null.
// Sin paréntesis (suficiente para el MVP).

fn parse_filter(s: &str) -> Result<Expr> {
    let toks = tokenize(s)?;
    let mut parser = Parser { toks, pos: 0 };
    let expr = parser.parse_or()?;
    if parser.pos != parser.toks.len() {
        return Err(anyhow!("unexpected trailing tokens in filter: {:?}", &parser.toks[parser.pos..]));
    }
    Ok(expr)
}

#[derive(Debug, Clone)]
enum Tok {
    Ident(String),
    Num(f64),
    Int(i64),
    Str(String),
    Bool(bool),
    Null,
    Op(String), // ==, !=, >, <, >=, <=
    And,
    Or,
}

fn tokenize(s: &str) -> Result<Vec<Tok>> {
    let mut out = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let mut buf = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                    buf.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            match buf.to_ascii_uppercase().as_str() {
                "AND" => out.push(Tok::And),
                "OR" => out.push(Tok::Or),
                "TRUE" => out.push(Tok::Bool(true)),
                "FALSE" => out.push(Tok::Bool(false)),
                "NULL" => out.push(Tok::Null),
                _ => out.push(Tok::Ident(buf)),
            }
            continue;
        }
        if c.is_ascii_digit() || c == '-' {
            let mut buf = String::new();
            buf.push(c);
            chars.next();
            let mut is_float = false;
            while let Some(&c) = chars.peek() {
                if c.is_ascii_digit() {
                    buf.push(c);
                    chars.next();
                } else if c == '.' && !is_float {
                    is_float = true;
                    buf.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            if is_float {
                out.push(Tok::Num(buf.parse()?));
            } else {
                out.push(Tok::Int(buf.parse()?));
            }
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            chars.next();
            let mut buf = String::new();
            for ch in chars.by_ref() {
                if ch == quote {
                    break;
                }
                buf.push(ch);
            }
            out.push(Tok::Str(buf));
            continue;
        }
        if matches!(c, '=' | '!' | '<' | '>') {
            let mut buf = String::new();
            buf.push(c);
            chars.next();
            if let Some(&nxt) = chars.peek() {
                if nxt == '=' {
                    buf.push(nxt);
                    chars.next();
                }
            }
            out.push(Tok::Op(buf));
            continue;
        }
        return Err(anyhow!("unexpected char in filter: {c:?}"));
    }
    Ok(out)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }
    fn bump(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        self.pos += 1;
        t
    }
    fn parse_or(&mut self) -> Result<Expr> {
        let mut lhs = self.parse_and()?;
        while matches!(self.peek(), Some(Tok::Or)) {
            self.bump();
            let rhs = self.parse_and()?;
            lhs = lhs.or(rhs);
        }
        Ok(lhs)
    }
    fn parse_and(&mut self) -> Result<Expr> {
        let mut lhs = self.parse_cmp()?;
        while matches!(self.peek(), Some(Tok::And)) {
            self.bump();
            let rhs = self.parse_cmp()?;
            lhs = lhs.and(rhs);
        }
        Ok(lhs)
    }
    fn parse_cmp(&mut self) -> Result<Expr> {
        let lhs = self.parse_atom()?;
        if let Some(Tok::Op(op)) = self.peek().cloned() {
            self.bump();
            let rhs = self.parse_atom()?;
            return Ok(match op.as_str() {
                "==" | "=" => lhs.eq(rhs),
                "!=" => lhs.neq(rhs),
                ">" => lhs.gt(rhs),
                "<" => lhs.lt(rhs),
                ">=" => lhs.gt_eq(rhs),
                "<=" => lhs.lt_eq(rhs),
                other => return Err(anyhow!("unknown operator: {other}")),
            });
        }
        Ok(lhs)
    }
    fn parse_atom(&mut self) -> Result<Expr> {
        match self.bump() {
            Some(Tok::Ident(s)) => Ok(col(s.as_str())),
            Some(Tok::Num(n)) => Ok(lit(n)),
            Some(Tok::Int(n)) => Ok(lit(n)),
            Some(Tok::Str(s)) => Ok(lit(s)),
            Some(Tok::Bool(b)) => Ok(lit(b)),
            Some(Tok::Null) => Ok(lit(NULL)),
            other => Err(anyhow!("expected atom, got {other:?}")),
        }
    }
}

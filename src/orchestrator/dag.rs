use crate::config::Step;
use anyhow::Result;
use std::collections::{HashMap, HashSet};

pub struct Dag {
    pub successors: HashMap<String, Vec<String>>,
    pub in_degree: HashMap<String, usize>,
    pub order: Vec<String>,
}

impl Dag {
    pub fn build(steps: &[Step]) -> Result<Self> {
        let mut successors: HashMap<String, Vec<String>> = HashMap::new();
        let mut in_degree: HashMap<String, usize> = HashMap::new();
        let order: Vec<String> = steps.iter().map(|s| s.id.clone()).collect();
        for s in steps {
            in_degree.entry(s.id.clone()).or_insert(0);
            successors.entry(s.id.clone()).or_default();
        }
        for s in steps {
            for d in &s.depends_on {
                successors.entry(d.clone()).or_default().push(s.id.clone());
                *in_degree.entry(s.id.clone()).or_insert(0) += 1;
            }
        }
        Ok(Self {
            successors,
            in_degree,
            order,
        })
    }
}

/// Closure de antecesores (deps transitivas) sobre el grafo de `steps`,
/// incluyendo el propio `target`.
pub fn ancestors_inclusive(steps: &[Step], target: &str) -> HashSet<String> {
    let mut deps: HashMap<&str, &Vec<String>> = HashMap::new();
    for s in steps {
        deps.insert(s.id.as_str(), &s.depends_on);
    }
    let mut out: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = vec![target.to_string()];
    while let Some(n) = stack.pop() {
        if out.insert(n.clone()) {
            if let Some(ds) = deps.get(n.as_str()) {
                for d in *ds {
                    if !out.contains(d) {
                        stack.push(d.clone());
                    }
                }
            }
        }
    }
    out
}

/// Closure de descendientes (sucesores transitivos), incluyendo el propio `target`.
pub fn descendants_inclusive(steps: &[Step], target: &str) -> HashSet<String> {
    // Construir grafo de sucesores
    let mut succ: HashMap<String, Vec<String>> = HashMap::new();
    for s in steps {
        succ.entry(s.id.clone()).or_default();
    }
    for s in steps {
        for d in &s.depends_on {
            succ.entry(d.clone()).or_default().push(s.id.clone());
        }
    }
    let mut out: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = vec![target.to_string()];
    while let Some(n) = stack.pop() {
        if out.insert(n.clone()) {
            if let Some(ch) = succ.get(&n) {
                for c in ch {
                    if !out.contains(c) {
                        stack.push(c.clone());
                    }
                }
            }
        }
    }
    out
}

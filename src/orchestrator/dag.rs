use crate::config::Step;
use anyhow::Result;
use std::collections::HashMap;

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

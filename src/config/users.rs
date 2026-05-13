use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsersFile {
    pub users: Vec<UserDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserDef {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Error)]
pub enum UsersError {
    #[error("invalid JSON in users file: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("user `{0}` already exists")]
    Duplicate(String),
    #[error("user `{0}` not found")]
    NotFound(String),
    #[error("user name cannot be empty")]
    EmptyName,
}

impl UsersFile {
    pub fn from_json_str(s: &str) -> Result<Self, UsersError> {
        Ok(serde_json::from_str(s)?)
    }
    pub fn empty() -> Self {
        Self { users: Vec::new() }
    }
    pub fn add(&mut self, u: UserDef) -> Result<(), UsersError> {
        let name = u.name.trim().to_string();
        if name.is_empty() {
            return Err(UsersError::EmptyName);
        }
        if self.users.iter().any(|x| x.name == name) {
            return Err(UsersError::Duplicate(name));
        }
        self.users.push(UserDef { name, ..u });
        Ok(())
    }
    pub fn remove(&mut self, name: &str) -> Result<(), UsersError> {
        let before = self.users.len();
        self.users.retain(|x| x.name != name);
        if self.users.len() == before {
            return Err(UsersError::NotFound(name.to_string()));
        }
        Ok(())
    }
}

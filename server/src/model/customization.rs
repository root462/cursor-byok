//! 提示词模板与 Skill 的领域类型。
use serde::{Deserialize, Serialize};

/// 支持提示词与 Skill 的客户端。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomizationClient {
    Claude,
    Codex,
}

impl CustomizationClient {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    /// 该客户端的全局提示词文件名。
    pub fn prompt_file_name(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE.md",
            Self::Codex => "AGENTS.md",
        }
    }
}

/// 一条提示词模板；同一客户端最多一条处于启用状态。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    pub content: String,
    pub enabled: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 提示词页面的完整状态：模板列表 + 目标文件位置 + 当前文件内容。
#[derive(Clone, Debug, Serialize)]
pub struct PromptSettings {
    pub client: CustomizationClient,
    /// 完整的目标文件路径，供 UI 复制。
    pub file_path: String,
    /// 把主目录写成 `~` 的展示路径。
    pub display_path: String,
    /// 磁盘上该文件的当前内容；文件不存在时为 `None`。
    pub file_content: Option<String>,
    pub prompts: Vec<PromptTemplate>,
}

/// 一个已安装的 Skill。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InstalledSkill {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// 主副本目录名（相对数据目录的 `skills/`）。
    pub directory: String,
    pub enabled_claude: bool,
    pub enabled_codex: bool,
    pub installed_at_ms: i64,
    pub updated_at_ms: i64,
}

impl InstalledSkill {
    pub fn enabled_for(&self, client: CustomizationClient) -> bool {
        match client {
            CustomizationClient::Claude => self.enabled_claude,
            CustomizationClient::Codex => self.enabled_codex,
        }
    }
}

/// Skill 页面状态：已安装列表 + 每个客户端实际生效的目录。
#[derive(Clone, Debug, Serialize)]
pub struct SkillSettings {
    /// 主副本目录的完整路径。
    pub storage_path: String,
    pub display_path: String,
    pub clients: Vec<SkillClientPaths>,
    pub skills: Vec<InstalledSkill>,
}

/// 单个客户端的 Skill 目录信息。
#[derive(Clone, Debug, Serialize)]
pub struct SkillClientPaths {
    pub client: CustomizationClient,
    pub skills_path: String,
    pub display_path: String,
    /// 该客户端目录里存在、但不属于本应用管理的 Skill 目录名。
    pub unmanaged: Vec<String>,
}

/// 新建或更新提示词时提交的内容。
#[derive(Clone, Debug, Deserialize)]
pub struct PromptInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub enabled: bool,
}

/// 从本机已安装的 Skill 里导入时提交的选择。
#[derive(Clone, Debug, Deserialize)]
pub struct SkillImportInput {
    /// 要导入的目录名；必须在某个客户端的 skills 目录里存在。
    pub directory: String,
    pub enabled_claude: bool,
    pub enabled_codex: bool,
}

/// 切换某个客户端上提示词的启用状态。
///
/// 停用会把目标文件清空；启用会先回填文件里的手改内容，再写入这条模板。
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct PromptEnabledInput {
    pub enabled: bool,
}

/// 直接粘贴 `SKILL.md` 文本安装一个 Skill。
#[derive(Clone, Debug, Deserialize)]
pub struct SkillPasteInput {
    /// 完整的 Markdown，必须以 YAML front matter 开头，`name` 决定目录名。
    pub markdown: String,
    #[serde(default)]
    pub enabled_claude: bool,
    #[serde(default)]
    pub enabled_codex: bool,
}

/// 切换某个客户端上 Skill 的启用状态。
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct SkillEnabledInput {
    pub enabled: bool,
}
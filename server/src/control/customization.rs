//! Implements prompt and skill management endpoints.
use axum::{
    extract::{Path, State},
    Json,
};

use crate::{
    customization::{Paths, PromptService, SkillInstallInput, SkillService},
    model::{CustomizationClient, PromptEnabledInput, PromptInput, PromptSettings, SkillImportInput, SkillPasteInput, SkillSettings},
    Error, Result,
};

use super::ControlService;

fn parse_client(raw: &str) -> Result<CustomizationClient> {
    CustomizationClient::parse(raw)
        .ok_or_else(|| Error::Config(format!("unsupported client for prompts/skills: {raw}")))
}

fn paths() -> Result<Paths> {
    Paths::system()
}

pub async fn prompt_settings(
    State(service): State<ControlService>,
    Path(client): Path<String>,
) -> Result<Json<PromptSettings>> {
    let client = parse_client(&client)?;
    Ok(Json(
        PromptService::settings(service.store(), &paths()?, client).await?,
    ))
}

pub async fn save_prompt(
    State(service): State<ControlService>,
    Path(client): Path<String>,
    Json(input): Json<PromptInput>,
) -> Result<Json<PromptSettings>> {
    let client = parse_client(&client)?;
    Ok(Json(PromptService::save(service.store(), &paths()?, client, input).await?))
}

pub async fn set_prompt_enabled(
    State(service): State<ControlService>,
    Path((client, id)): Path<(String, String)>,
    Json(input): Json<PromptEnabledInput>,
) -> Result<Json<PromptSettings>> {
    let client = parse_client(&client)?;
    Ok(Json(
        PromptService::set_enabled(service.store(), &paths()?, client, &id, input.enabled).await?,
    ))
}

pub async fn delete_prompt(
    State(service): State<ControlService>,
    Path((client, id)): Path<(String, String)>,
) -> Result<Json<PromptSettings>> {
    let client = parse_client(&client)?;
    Ok(Json(
        PromptService::delete(service.store(), &paths()?, client, &id).await?,
    ))
}

pub async fn skill_settings(
    State(service): State<ControlService>,
) -> Result<Json<SkillSettings>> {
    Ok(Json(SkillService::settings(service.store(), &paths()?).await?))
}

pub async fn install_skill(
    State(service): State<ControlService>,
    Json(input): Json<SkillInstallInput>,
) -> Result<Json<SkillSettings>> {
    Ok(Json(SkillService::install(service.store(), &paths()?, input).await?))
}

pub async fn paste_skill(
    State(service): State<ControlService>,
    Json(input): Json<SkillPasteInput>,
) -> Result<Json<SkillSettings>> {
    Ok(Json(
        SkillService::install_from_markdown(service.store(), &paths()?, input).await?,
    ))
}

pub async fn import_skills(
    State(service): State<ControlService>,
    Path(client): Path<String>,
    Json(input): Json<SkillImportInput>,
) -> Result<Json<SkillSettings>> {
    let client = parse_client(&client)?;
    Ok(Json(
        SkillService::import_from_client(service.store(), &paths()?, client, input).await?,
    ))
}

pub async fn set_skill_enabled(
    State(service): State<ControlService>,
    Path((id, client)): Path<(String, String)>,
    Json(input): Json<crate::model::SkillEnabledInput>,
) -> Result<Json<SkillSettings>> {
    let client = parse_client(&client)?;
    Ok(Json(
        SkillService::set_enabled(service.store(), &paths()?, &id, client, input.enabled).await?,
    ))
}

pub async fn uninstall_skill(
    State(service): State<ControlService>,
    Path(id): Path<String>,
) -> Result<Json<SkillSettings>> {
    Ok(Json(SkillService::uninstall(service.store(), &paths()?, &id).await?))
}
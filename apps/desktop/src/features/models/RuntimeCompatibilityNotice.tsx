import { TitledCard } from "../../shared/ui/TitledCard";

export function RuntimeCompatibilityNotice() {
  return <TitledCard title={t("检测到 Cursor 运行流程不兼容")}>
    <div role="status">
      <p>{t("已向客户端发送安全切回后端 Agent 的信号。这是协议不匹配，不代表旧会话损坏；网关没有修改会话数据。")}</p>
      <p>{t("若 Cursor 已恢复回复，可继续使用原会话。检测记录不代表切换已经成功。")}</p>
      <ol>
        <li>{t("若提示继续或恢复，请先在原会话中点击继续。")}</li>
        <li>{t("若仍失败，保存工作并完全退出、重新启动 Cursor，再打开原会话，重新选择已配置的模型后重试。")}</li>
        <li>{t("无需先删除或新建会话；若仍失败，请保留原会话并检查日志，不要清空数据库或缓存。")}</li>
      </ol>
    </div>
  </TitledCard>;
}

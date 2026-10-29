import { ExternalLink, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { Feature, Watch, WatchDraft } from "../shared/contracts";
import { adoptionLabels, featureReview } from "../shared/feature-review";
import { Badge, Body, Button, Field, Row, type Themed } from "./kit";

const adoptionOptions = Object.entries(adoptionLabels).map(
  ([value, label]) => ({ value, label }),
);
export function ReviewEditor({
  theme,
  review,
  onChange,
}: Themed & {
  review: NonNullable<WatchDraft["review"]>;
  onChange(review: WatchDraft["review"]): void;
}) {
  const update = (index: number, patch: Partial<Feature>) =>
    onChange({
      ...review,
      features: review.features.map((feature, i) =>
        i === index ? { ...feature, ...patch } : feature,
      ),
    });
  return (
    <View style={{ gap: 12 }}>
      <Body theme={theme}>核心功能清单 · 仅提出建议</Body>
      <Body theme={theme} muted>
        状态是人工登记的评估；定时扫描只核对路径变化。建议 agent
        会读取实际源码复核，不能执行移植。
      </Body>
      {review.features.map((feature, index) => (
        <View
          key={index}
          style={{
            gap: 6,
            padding: 10,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Row>
            <Body theme={theme}>{feature.title}</Body>
            <Button
              theme={theme}
              label="移除此功能"
              disabled={review.features.length === 1}
              onPress={() =>
                onChange({
                  ...review,
                  features: review.features.filter((_, i) => i !== index),
                })
              }
            />
          </Row>
          <Field
            theme={theme}
            value={feature.title}
            placeholder="功能名称"
            onChange={(title) => update(index, { title })}
          />
          <SettingsSelect
            label="登记的移植状态"
            value={feature.adoption}
            options={adoptionOptions}
            onValueChange={(adoption) =>
              update(index, { adoption: adoption as Feature["adoption"] })
            }
          />
          <Body theme={theme} muted>
            上游相对路径（每行一个）
          </Body>
          <Field
            theme={theme}
            multiline
            placeholder="例如 src/memory"
            value={feature.upstreamPaths.join("\n")}
            onChange={(value) =>
              update(index, { upstreamPaths: value.split(/\r?\n/) })
            }
          />
          <Body theme={theme} muted>
            本地证据路径，相对插件目录（每行一个，可空）
          </Body>
          <Field
            theme={theme}
            multiline
            placeholder="例如 server/memory.ts"
            value={feature.localPaths.join("\n")}
            onChange={(value) =>
              update(index, { localPaths: value ? value.split(/\r?\n/) : [] })
            }
          />
          <Field
            theme={theme}
            multiline
            value={feature.notes}
            placeholder="证据、未完成部分与保留决定"
            onChange={(notes) => update(index, { notes })}
          />
        </View>
      ))}
      <Button
        theme={theme}
        label="添加核心功能"
        disabled={review.features.length >= 24}
        onPress={() =>
          onChange({
            ...review,
            features: [
              ...review.features,
              {
                id: `feature-${Date.now()}`,
                title: "新功能",
                upstreamPaths: ["src"],
                localPaths: [],
                adoption: "missing",
                notes: "",
              },
            ],
          })
        }
      />
    </View>
  );
}

export function ReviewReport({ theme, watch }: Themed & { watch: Watch }) {
  const report = featureReview(watch);
  if (!report) return null;
  return (
    <View style={{ gap: 10 }}>
      <Body theme={theme}>核心功能对照 · 仅建议，不自动移植</Body>
      <Body theme={theme} muted>
        移植状态来自登记清单，须按实际代码和验收复核。无路径变化不代表功能已经完成。
      </Body>
      {!report.complete ? (
        <Body theme={theme}>
          当前差异证据未完整确认：
          {report.error || "首次扫描未完成、历史分歧或文件列表截断"}。
        </Body>
      ) : null}
      {report.features.map((feature) => (
        <View key={feature.id} style={{ gap: 5 }}>
          <Row>
            <Body theme={theme}>{feature.title}</Body>
            <Badge
              theme={theme}
              label={adoptionLabels[feature.adoption]}
              warning={
                feature.adoption === "missing" || feature.adoption === "partial"
              }
            />
          </Row>
          <Body theme={theme}>
            {feature.changedFiles.length
              ? `${feature.changedFiles.length} 个相关文件变化。`
              : feature.evidence === "unknown"
                ? "路径变化尚不能确认。"
                : "本次范围无路径变化。"}
            {feature.recommendation}
          </Body>
          <Body theme={theme} muted>
            {feature.notes}
          </Body>
          {feature.localPaths.length ? (
            <Body theme={theme} mono>
              本地：{feature.localPaths.join("、")}
            </Body>
          ) : null}
          {feature.sources.map((source) => (
            <Row key={source.path}>
              <Body theme={theme} mono>
                {source.path}
              </Body>
              {source.baselineUrl ? (
                <ExternalLink href={source.baselineUrl}>
                  <Text style={{ color: theme.colors.accent }}>基线源码</Text>
                </ExternalLink>
              ) : null}
              {source.headUrl ? (
                <ExternalLink href={source.headUrl}>
                  <Text style={{ color: theme.colors.accent }}>扫描版本</Text>
                </ExternalLink>
              ) : null}
            </Row>
          ))}
          {feature.changedFiles.slice(0, 8).map((file) => (
            <Body theme={theme} mono key={file.path}>
              {file.status} {file.previousPath ? `${file.previousPath} → ` : ""}
              {file.path}
            </Body>
          ))}
        </View>
      ))}
      {report.unclassifiedFiles.length ? (
        <Body theme={theme}>
          另有 {report.unclassifiedFiles.length}{" "}
          个变更文件尚未归入功能清单。建议 agent 也会检查是否出现新的核心功能。
        </Body>
      ) : null}
    </View>
  );
}

"use client";
import { useId, useState } from "react";
import type { AgentInteraction } from "@localapp/sdk-agent/harness-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { MessageSquare, ShieldCheck } from "lucide-react";

export function AgentInteractionCard({ interaction, answer, pending = false }: {
  interaction: AgentInteraction; answer: (result: unknown) => void; pending?: boolean;
}) {
  const prefix = useId();
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom: string }>>({});
  const update = (id: string, patch: Partial<{ selected: string[]; custom: string }>) => setAnswers(previous => ({ ...previous, [id]: { ...(previous[id] ?? { selected: [], custom: "" }), ...patch } }));
  if (interaction.kind === "approval") return <Card role="group" aria-label="操作确认" className="agent-interaction-card space-y-4 p-4 shadow-none">
    <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck size={16} />操作确认</div>
    <p className="text-sm leading-6">{interaction.toolName}：{interaction.reason || "此操作需要确认"}</p>
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={pending} onClick={() => answer("rejected")}>拒绝</Button><Button disabled={pending} onClick={() => answer("allowed-once")}>允许本次操作</Button></div>
  </Card>;
  const questions = interaction.questions ?? [];
  return <Card className="agent-interaction-card p-4 shadow-none"><form aria-label="回答 Agent 问题" className="space-y-5" onSubmit={event => { event.preventDefault(); answer({ answers: questions.map(q => ({ id: q.id, selected: answers[q.id]?.selected ?? [], custom: answers[q.id]?.custom ?? "" })) }); }}>
    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><MessageSquare size={16} />需要你的回答</div>
    {questions.map((question, questionIndex) => {
      const selected = answers[question.id]?.selected ?? [];
      const options = question.options ?? [];
      const optionRows = options.map((option, index) => {
        const id = `${prefix}-${questionIndex}-${index}`;
        const checked = selected.includes(option.label);
        return <Label key={option.label} htmlFor={id} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition-colors hover:bg-accent ${checked ? "border-primary/50 bg-primary/5" : "border-border"}`}>
          {question.multiSelect ? <Checkbox id={id} disabled={pending} checked={checked} className="mt-0.5" onCheckedChange={value => update(question.id, { selected: value === true ? [...selected, option.label] : selected.filter(label => label !== option.label) })} /> : <RadioGroupItem id={id} value={option.label} disabled={pending} className="mt-0.5" />}
          <span className="space-y-1"><span className="block text-sm leading-5">{option.label}</span>{option.description && <span className="block text-xs font-normal leading-5 text-muted-foreground">{option.description}</span>}</span>
        </Label>;
      });
      return <fieldset key={question.id} className="space-y-3" disabled={pending}>
        <legend className="text-sm font-medium leading-6">{question.question}</legend>
        {question.detail && <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{question.detail}</p>}
        {options.length > 0 && (question.multiSelect ? <div className="grid gap-2">{optionRows}</div> : <RadioGroup aria-label={question.question} value={selected[0] ?? ""} onValueChange={value => update(question.id, { selected: [value] })}>{optionRows}</RadioGroup>)}
        <Textarea aria-label={`${question.question} 自定义回答`} placeholder={options.length ? "补充说明（可选）" : "请输入你的回答…"} className="min-h-20 resize-y" value={answers[question.id]?.custom ?? ""} onChange={event => update(question.id, { custom: event.target.value })} />
      </fieldset>;
    })}
    <div className="flex justify-end border-t pt-3"><Button type="submit" disabled={pending || !questions.length || questions.some(q => !answers[q.id]?.selected.length && !answers[q.id]?.custom.trim())}>{pending ? "正在提交…" : "提交回答"}</Button></div>
  </form></Card>;
}

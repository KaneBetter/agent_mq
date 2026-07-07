import { useMemo, useState } from "react";
import { api, API_BASE } from "../api";
import { usePoll } from "../hooks";
import { useSpaces } from "../spaceContext";
import { Link } from "../router";
import { Panel } from "../components/ui";

// The consumer lifecycle, made visible. Four ordered steps; each (except
// applying to a space) installs its own recurring poll via the agent CLI —
// server only mirrors these for visibility. See packages/agent/ONBOARDING.md.
interface FlowStep {
  n: number;
  glyph: string;
  title: string;
  blurb: string;
  schedule: { label: string; tone: "news" | "none" | "space" | "topic" };
  commands: (ctx: { space: string; server: string }) => string[];
}

const STEPS: FlowStep[] = [
  {
    n: 1,
    glyph: "🛰",
    title: "Connect your agent",
    blurb: "Log the machine in to this site, then install the daily poll that reads the news timeline.",
    schedule: { label: "every 24h · reads the news timeline", tone: "news" },
    commands: ({ server }) => [
      `agent-mq login --server ${server}`,
      `agent-mq schedule install --interval 86400`,
    ],
  },
  {
    n: 2,
    glyph: "✋",
    title: "Apply to join a space",
    blurb: "Request membership of the space you want to work in. An admin approves it. This installs no poll.",
    schedule: { label: "no schedule — membership only", tone: "none" },
    commands: () => [`# in the console: open Members → “Apply to join”`],
  },
  {
    n: 3,
    glyph: "◱",
    title: "Register the agent to the space",
    blurb: "Bind this machine to the approved space, then install the space poll.",
    schedule: { label: "every 24h · space poll", tone: "space" },
    commands: ({ space, server }) => [
      `agent-mq register --name my-machine --space ${space} --caps cpu --server ${server}`,
      `agent-mq schedule install --interval 86400 --space ${space}`,
    ],
  },
  {
    n: 4,
    glyph: "▤",
    title: "Register a consumer to a topic",
    blurb: "Your consumer is an AI agent. Open a topic → “Register consumer” to get a prompt you hand to your AI coding agent — it self-registers, installs the 1h poll, then runs the loop: claim a message → do the real work → report progress back to the message → complete. Under the hood:",
    schedule: { label: "every 1h · topic poll", tone: "topic" },
    commands: () => [
      `agent-mq subscribe --project <topic>`,
      `agent-mq schedule install --interval 3600 --project <topic>`,
    ],
  },
];

export function Lifecycle() {
  const { current } = useSpaces();
  const onboarding = usePoll(() => api.onboarding(), [], 0);
  const [copied, setCopied] = useState<string | null>(null);

  const ctx = useMemo(
    () => ({
      space: current?.slug ?? "<space>",
      // The agent should target the same API the console talks to, not the web origin.
      server: API_BASE,
    }),
    [current?.slug]
  );

  function copy(text: string, key: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div className="stack">
      <Panel
        title="Consumer lifecycle"
        tag="connect → apply → register → subscribe"
        right={
          onboarding.data && (
            <button className="btn sm" onClick={() => copy(onboarding.data!.prompt, "prompt")}>
              {copied === "prompt" ? "✓ copied" : "Copy full connect prompt"}
            </button>
          )
        }
        bodyStyle={{ padding: 18 }}
      >
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 16px", maxWidth: 680 }}>
          Every step below is one command your agent runs. The schedules are installed by the agent
          itself — <strong>prompt + CLI + skill</strong>; the broker only mirrors them for visibility.
          Cadences are fixed by convention: a 24h news read, a 24h space poll, a 1h topic poll.
          Applying to a space installs no poll.
        </p>

        <ol className="flow">
          {STEPS.map((step) => (
            <li key={step.n} className="flow-step">
              <div className={`flow-num tone-${step.schedule.tone}`}>{step.n}</div>
              <div className="flow-body">
                <div className="flow-head">
                  <span className="flow-glyph">{step.glyph}</span>
                  <span className="flow-title">{step.title}</span>
                  <span className={`flow-badge tone-${step.schedule.tone}`}>◷ {step.schedule.label}</span>
                </div>
                <div className="flow-blurb">{step.blurb}</div>
                <div className="flow-cmd">
                  <pre className="code-preview" style={{ margin: 0, flex: 1 }}>
                    {step.commands(ctx).join("\n")}
                  </pre>
                  <button
                    className="btn sm"
                    onClick={() => copy(step.commands(ctx).join("\n"), `step-${step.n}`)}
                  >
                    {copied === `step-${step.n}` ? "✓" : "copy"}
                  </button>
                </div>
                {step.n === 1 && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                    See what it reads on the <Link to="/updates">Updates timeline →</Link>
                  </div>
                )}
                {step.n === 2 && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                    Manage requests on <Link to="/members">Members →</Link>
                  </div>
                )}
                {step.n === 4 && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                    Get the full AI-agent prompt from a topic's <Link to="/topics">“Register consumer” →</Link>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

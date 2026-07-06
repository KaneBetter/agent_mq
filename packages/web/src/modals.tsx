import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { RegisterAgentModal } from "./components/RegisterAgentModal";
import { ScheduleModal } from "./components/ScheduleModal";

export type TopicRef = { id: string; name: string };

interface ModalApi {
  /** Register a consumer, optionally bound to a topic (auto-subscribe). */
  openRegister: (topic?: TopicRef | null) => void;
  /** Create a recurring schedule on a topic. */
  openSchedule: (topic: TopicRef) => void;
}

const ModalContext = createContext<ModalApi>({ openRegister: () => {}, openSchedule: () => {} });
export function useModals() {
  return useContext(ModalContext);
}

export function ModalProvider({ children, onChanged }: { children: ReactNode; onChanged?: () => void }) {
  const [register, setRegister] = useState<{ open: boolean; topic: TopicRef | null }>({ open: false, topic: null });
  const [schedule, setSchedule] = useState<TopicRef | null>(null);

  const api: ModalApi = {
    openRegister: (topic) => setRegister({ open: true, topic: topic ?? null }),
    openSchedule: (topic) => setSchedule(topic),
  };

  return (
    <ModalContext.Provider value={api}>
      {children}
      {register.open && (
        <RegisterAgentModal
          project={register.topic}
          onClose={() => setRegister({ open: false, topic: null })}
          onRegistered={onChanged}
        />
      )}
      {schedule && (
        <ScheduleModal project={schedule} onClose={() => setSchedule(null)} onCreated={onChanged} />
      )}
    </ModalContext.Provider>
  );
}

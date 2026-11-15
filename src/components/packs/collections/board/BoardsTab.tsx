import { useLingui } from "@lingui/react/macro";
import { Section, SectionHeading } from "../chrome";
import { CardBoard } from "./CardBoard";

/* The boards tab: one table everybody lays their cards out on. */
export function BoardsTab({ at }: { at?: string }) {
  const { t } = useLingui();
  return (
    <Section>
      <SectionHeading>{t`the board`}</SectionHeading>
      <div className="mt-3">
        <CardBoard at={at} />
      </div>
    </Section>
  );
}

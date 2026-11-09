import { useState } from 'react';
import { useHost } from '@agentage/widget';
import { Button, Card } from '@agentage/widget/ds';

export function Echo() {
  const { tool, context } = useHost();
  const [answer, setAnswer] = useState('');
  // A refused call (no token on next) shows the host's reason, not an empty card.
  const ping = () =>
    tool(`${context.extension}__echo`, { msg: 'hi' }).then(
      ({ msg }) => String(msg),
      (error: Error) => error.message
    );
  return (
    <Card title={context.extension}>
      <Button onClick={async () => setAnswer(await ping())}>ping</Button>
      <p>{answer}</p>
    </Card>
  );
}

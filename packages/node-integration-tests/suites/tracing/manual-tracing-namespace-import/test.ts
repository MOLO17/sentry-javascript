import { assertSentryTransaction, getEnvelopeRequest, runServer } from '../../../utils';

test.skip('should send a manually started transaction when @sentry/tracing is imported using namespace import.', async () => {
  const url = await runServer(__dirname);
  const envelope = await getEnvelopeRequest(url);

  expect(envelope).toHaveLength(3);

  assertSentryTransaction(envelope[2], {
    transaction: 'test_transaction_1',
  });
});

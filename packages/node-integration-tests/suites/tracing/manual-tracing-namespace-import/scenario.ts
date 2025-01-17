import * as Sentry from '@sentry/node';
import * as _ from '@sentry/tracing';

Sentry.init({
  dsn: 'https://public@dsn.ingest.sentry.io/1337',
  release: '1.0',
  tracesSampleRate: 1.0,
});

const transaction = Sentry.startTransaction({ name: 'test_transaction_1' });

transaction.finish();

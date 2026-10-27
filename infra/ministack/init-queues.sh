#!/bin/sh
set -eu

QUEUE_ATTRIBUTES='{"FifoQueue":"true","ContentBasedDeduplication":"false"}'
DLQ_NAME='wager-transactions-dlq.fifo'
QUEUE_NAME='wager-transactions.fifo'
EVENTS_QUEUE_NAME='wager-events.fifo'
DLQ_ARN="arn:aws:sqs:${AWS_DEFAULT_REGION:-us-east-1}:000000000000:${DLQ_NAME}"

awslocal sqs create-queue --queue-name "$DLQ_NAME" --attributes "$QUEUE_ATTRIBUTES"

MAIN_QUEUE_ATTRIBUTES="{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

awslocal sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "$MAIN_QUEUE_ATTRIBUTES"

awslocal sqs create-queue \
  --queue-name "$EVENTS_QUEUE_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30"}'

echo 'MiniStack SQS input, output and DLQ queues initialized.'

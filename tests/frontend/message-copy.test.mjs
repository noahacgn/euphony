import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

async function loadMessageCopyModule() {
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    optimizeDeps: {
      entries: [],
      noDiscovery: true
    },
    server: {
      hmr: false,
      middlewareMode: true
    }
  });

  try {
    return await server.ssrLoadModule('/src/utils/message-copy.ts');
  } finally {
    await server.close();
  }
}

test('getMessageCopyText keeps string message content unchanged', async () => {
  const { getMessageCopyText } = await loadMessageCopyModule();

  assert.equal(
    getMessageCopyText({
      content: 'Keep this exact string\nwith its line break.'
    }),
    'Keep this exact string\nwith its line break.'
  );
});

test('getMessageCopyText copies text message source with markdown intact', async () => {
  const { getMessageCopyText } = await loadMessageCopyModule();

  assert.equal(
    getMessageCopyText({
      content: [
        {
          text: '# Title\n\nKeep **markdown** and $x^2$.'
        }
      ]
    }),
    '# Title\n\nKeep **markdown** and $x^2$.'
  );
});

test('getMessageCopyText copies code text without adding language labels', async () => {
  const { getMessageCopyText } = await loadMessageCopyModule();

  assert.equal(
    getMessageCopyText({
      content: [
        {
          content_type: 'code',
          language: 'python',
          text: 'print("hello")'
        }
      ]
    }),
    'print("hello")'
  );
});

test('getMessageCopyText copies structured system content as formatted JSON', async () => {
  const { getMessageCopyText } = await loadMessageCopyModule();

  assert.equal(
    getMessageCopyText({
      content: [
        {
          model_identity: 'You are ChatGPT.',
          channel_config: {
            valid_channels: ['analysis', 'final'],
            channel_required: true
          }
        }
      ]
    }),
    JSON.stringify(
      {
        model_identity: 'You are ChatGPT.',
        channel_config: {
          valid_channels: ['analysis', 'final'],
          channel_required: true
        }
      },
      null,
      2
    )
  );
});

test('getMessageCopyText copies structured developer content as formatted JSON', async () => {
  const { getMessageCopyText } = await loadMessageCopyModule();

  assert.equal(
    getMessageCopyText({
      content: [
        {
          instructions: 'Use concise answers.',
          tools: {
            web: {
              name: 'web',
              tools: [
                {
                  name: 'search',
                  description: 'Search the web'
                }
              ]
            }
          }
        }
      ]
    }),
    JSON.stringify(
      {
        instructions: 'Use concise answers.',
        tools: {
          web: {
            name: 'web',
            tools: [
              {
                name: 'search',
                description: 'Search the web'
              }
            ]
          }
        }
      },
      null,
      2
    )
  );
});

test('getMessageCopyText falls back to formatted JSON for unknown content', async () => {
  const { getMessageCopyText } = await loadMessageCopyModule();
  const content = [
    {
      custom_type: 'image',
      url: 'aquifer://image.png'
    }
  ];

  assert.equal(
    getMessageCopyText({
      content
    }),
    JSON.stringify(content, null, 2)
  );
});

test('getMessageCopyText returns a string for missing content', async () => {
  const { getMessageCopyText } = await loadMessageCopyModule();

  assert.equal(
    getMessageCopyText({
      content: undefined
    }),
    'undefined'
  );
});

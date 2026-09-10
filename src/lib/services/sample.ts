import type { Workspace } from './workspace.svelte';
import { defaultData, newId, textDoc } from '../domain/defaults';
import { createRunSnapshot } from '../domain/testing';
/** Explicit opt-in sample, isolated from real user projects. */
export async function createSample(workspace: Workspace) {
  const project = await workspace.createProject(
    'Atlas storefront · sample',
    'An example project for exploring Tracefold. All content is fictional.',
    'AT',
  );
  await workspace.openProject(project.id);
  const environment = {
    build: '2.8.0 (142)',
    platform: 'macOS',
    browser: 'Safari',
    device: 'Desktop',
    locale: 'en-GB',
    extra: {},
  };
  const session = await workspace.create('session', 'Checkout, from cart to confirmation', {
    ...defaultData('session'),
    charter:
      'Explore the checkout journey, with attention to address handling and payment recovery.',
    environment,
    focusAreas: [
      { text: 'Cart & order summary', checked: true },
      { text: 'Address entry & validation', checked: true },
      { text: 'Payment failure & recovery', checked: false },
      { text: 'Confirmation & receipt', checked: false },
    ],
  });
  const observation = await workspace.create('entry', 'Order summary stays clear and consistent', {
    ...defaultData('entry'),
    sessionId: session.id,
    category: 'observation',
  });
  workspace.edit({
    ...observation,
    body: textDoc(
      'Reviewed the order summary with three items and a discount applied. Item prices, delivery, and the final total remain visible throughout checkout.',
    ),
  });
  const pass = await workspace.create('entry', 'Empty fields show helpful validation', {
    ...defaultData('entry'),
    sessionId: session.id,
    category: 'passed',
  });
  workspace.edit({
    ...pass,
    body: textDoc(
      'Submitted the address form without a postcode. Focus moved to the field and the error explained what was needed.',
    ),
  });
  const finding = await workspace.create(
    'finding',
    'Apartment number is lost after editing the address',
    {
      ...defaultData('finding'),
      code: 'AT-001',
      component: 'Checkout',
      environment,
      steps: [
        'Add an address with an apartment number.',
        'Continue to payment, then return to edit the address.',
      ],
      expected: 'All address details, including the apartment number, remain populated.',
      actual: 'The apartment field is empty when the address is reopened.',
      impact: 'A customer could place an order with incomplete delivery details.',
      frequency: '3 of 3 attempts',
      suspectedCause: 'The edit form may be reading an incomplete address model.',
    },
  );
  await workspace.create('entry', 'Apartment number disappears when editing', {
    ...defaultData('entry'),
    sessionId: session.id,
    category: 'issue',
    expected: finding.data.expected,
    actual: finding.data.actual,
    findingId: finding.id,
  });
  const requirement = await workspace.create(
    'requirement',
    'Delivery address is preserved through checkout',
    {
      ...defaultData('requirement'),
      code: 'REQ-01',
      description: 'Customers can review and edit their complete delivery address.',
      acceptanceCriteria: 'Every address field is retained when navigating between checkout steps.',
    },
  );
  const testCase = await workspace.create(
    'case',
    'Edit a delivery address without losing details',
    {
      ...defaultData('case'),
      folder: 'Checkout / Delivery',
      prerequisites: 'A cart containing a shippable item.',
      requirementIds: [requirement.id],
      steps: [
        {
          id: newId(),
          action: 'Enter an address with an apartment number.',
          expected: 'The complete address appears in the summary.',
        },
        {
          id: newId(),
          action: 'Continue to payment, then edit the address.',
          expected: 'All address fields retain their values.',
        },
      ],
    },
  );
  const run = createRunSnapshot([testCase], environment, {
    runId: newId(),
    at: new Date().toISOString(),
  });
  if (run.ok) await workspace.create('run', 'Checkout smoke · build 142', run.value);
  const doc = await workspace.create('document', 'Welcome to the Atlas sample');
  workspace.edit({
    ...doc,
    body: textDoc(
      'This is a fictional project to help you explore Tracefold.\nOpen the exploratory session to follow a tester’s investigation. The issue is linked to a finding, and a reusable test case covers the requirement.\nYour own work belongs in a separate project. You can archive this sample from Settings.',
    ),
  });
  await workspace.flush();
  workspace.navigate('notebook', session.id);
}

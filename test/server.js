import { expect } from 'chai';

import Server from '../lib/server';

describe('üWave Server', () => {
  it('can instantiate a Server object', () => {
    expect(new Server({ /* options */ }))
      .to.be.instanceOf(Server);
  });
});

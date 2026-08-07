import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
const execFileAsync = promisify(execFile);

async function opRead(ref: string): Promise<string> {
  const { stdout } = await execFileAsync('op', ['read', ref], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function getDeliveryAddress() {
  const [address1, city, state, zip, phone] = await Promise.all([
    opRead(config.refs.address1), opRead(config.refs.city), opRead(config.refs.state),
    opRead(config.refs.zip), opRead(config.refs.phone)
  ]);
  return { address1, city, state, zip, phone };
}

export async function getPaymentCard() {
  // Deliberately called only AFTER Telegram approval.
  const [number, expMonth, expYear, cvv, name] = await Promise.all([
    opRead(config.refs.cardNumber), opRead(config.refs.expMonth), opRead(config.refs.expYear),
    opRead(config.refs.cvv), opRead(config.refs.cardName)
  ]);
  return { number, expMonth, expYear, cvv, name };
}

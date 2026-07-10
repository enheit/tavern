// A shared, ordered event log so an RTC test can assert the exact interleaving of peer-connection
// SDP ops and SFU signalling calls (e.g. addTransceiver → createOffer → setLocal → publishTracks →
// setRemote). The FakeRtcPort and FakeSignal record into the same instance when it is passed to both.
export class EventLog {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

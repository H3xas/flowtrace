using System.Threading.Tasks;

namespace Loom.Gates.Services
{
    public interface IShuttleAudit { Task Record(string trace); }
    public interface IThreadLedger { Task Append(string trace); }
    public interface IBobbinStore { Task Wind(); }

    public class ShuttleAudit : IShuttleAudit
    {
        private readonly IThreadLedger _ledger;

        public ShuttleAudit(IThreadLedger ledger)
        {
            _ledger = ledger;
        }

        public async Task Record(string trace)
        {
            await _ledger.Append(trace);
        }
    }

    public class ThreadLedger : IThreadLedger
    {
        public Task Append(string trace) { return Task.CompletedTask; }
    }

    public class BobbinStore : IBobbinStore
    {
        public Task Wind() { return Task.CompletedTask; }
    }
}

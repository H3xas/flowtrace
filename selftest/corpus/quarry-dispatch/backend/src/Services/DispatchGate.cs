using System.Threading.Tasks;

namespace QuarryDispatch.Api.Services
{
    public interface IDispatchGate
    {
        Task<bool> Decide(string serial);
    }

    public class PrimaryGate : IDispatchGate
    {
        private readonly DispatchLedger _ledger;

        public PrimaryGate(DispatchLedger ledger)
        {
            _ledger = ledger;
        }

        public async Task<bool> Decide(string serial)
        {
            await _ledger.Record(serial);
            return true;
        }
    }

    public class ShadowGate : IDispatchGate
    {
        private readonly DispatchLedger _ledger;

        public ShadowGate(DispatchLedger ledger)
        {
            _ledger = ledger;
        }

        public async Task<bool> Decide(string serial)
        {
            await _ledger.Record(serial);
            return false;
        }
    }
}

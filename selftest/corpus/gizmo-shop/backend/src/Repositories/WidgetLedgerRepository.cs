// A ledger repository whose preceding method is stored with stray carriage returns.
// The file is deliberately mixed-terminator: PruneStaleEntries below ends its lines
// CR CR LF, every other line ends LF. C# treats a bare CR as a line terminator, so a
// reader that counts lines by LF alone and a reader that splits on any terminator
// disagree about every line after it, by exactly the number of stray CRs seen so far.
//
// Both `if (!removed)` and `if (!archived)` sit six lines above their own closing
// brace, which is exactly that disagreement, so a pass that pairs one line model with
// the other resolves them to their method's `}` and stops seeing them. The guard `if`
// higher up in the same method resolves to a blank line inside the body and survives,
// which is what makes the loss look construct-specific when it is file-shaped.
//
// Invented names throughout; no real service, schema or codebase is described here.

using System.Threading.Tasks;

namespace GizmoShop.Api.Repositories
{
    public interface IWidgetLedger
    {
        Task<int> PruneAsync(int keepCount);
        Task<bool> RemoveAsync(string entryCode);
        Task<bool> ArchiveAsync(string entryCode);
    }

    public class WidgetLedgerRepository
    {
        private readonly IWidgetLedger _ledger;

        public WidgetLedgerRepository(IWidgetLedger ledger)
        {
            _ledger = ledger;
        }

        public async Task<int> PruneStaleEntries(int keepCount)
        {
            var pruned = await _ledger.PruneAsync(keepCount);
            return pruned;
        }

        public async Task<bool> RemoveEntry(string entryCode)
        {
            if (entryCode == null)
            {
                return false;
            }

            var removed = await _ledger.RemoveAsync(entryCode);

            if (!removed)
            {
                return false;
            }

            return true;
        }

        public async Task<bool> ArchiveEntry(string entryCode)
        {
            if (entryCode == null)
            {
                return false;
            }

            var archived = await _ledger.ArchiveAsync(entryCode);

            if (!archived)
            {
                return false;
            }

            return true;
        }
    }
}

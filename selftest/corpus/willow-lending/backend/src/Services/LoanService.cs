using Fernway.Ledger;
using Fernway.Audit;
using Fernway.Notices;

namespace WillowLending.Api.Services
{
    public interface ILoanService
    {
        string Read(string loanId);
        string Settle(string loanId);
    }

    public class LoanService : ILoanService
    {
        private readonly ILedgerClient _ledger;
        private readonly NoticeSender _notices;
        private readonly SettlementBook _book;
        private readonly AuditTrail _trail;

        public LoanService(ILedgerClient ledger, NoticeSender notices, SettlementBook book, AuditTrail trail)
        {
            _ledger = ledger;
            _notices = notices;
            _book = book;
            _trail = trail;
        }

        public string Read(string loanId)
        {
            _notices.Send(loanId);
            _trail.Record(loanId);
            return _ledger.Fetch(loanId);
        }

        public string Settle(string loanId)
        {
            _notices.Send(loanId);
            return _book.Close(loanId);
        }
    }
}

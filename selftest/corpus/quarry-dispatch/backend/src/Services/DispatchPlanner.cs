using System.Threading.Tasks;

namespace QuarryDispatch.Api.Services
{
    public class DispatchPlanner
    {
        private readonly SurveyA _survey;
        private readonly DispatchLedger _ledger;

        public DispatchPlanner(SurveyA survey, DispatchLedger ledger)
        {
            _survey = survey;
            _ledger = ledger;
        }

        public async Task<string> Plan(string serial)
        {
            await _survey.StepOne(serial);
            await _survey.StepTwo(serial);
            await _survey.StepThree(serial);
            await _ledger.Record(serial);
            return serial;
        }
    }
}

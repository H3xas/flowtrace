using System.Threading.Tasks;

namespace QuarryDispatch.Api.Services
{
    public class DispatchLedger
    {
        private readonly IDispatchPlanRepository _repository;

        public DispatchLedger(IDispatchPlanRepository repository)
        {
            _repository = repository;
        }

        public Task Record(string serial)
        {
            return _repository.SavePlan(serial);
        }
    }
}

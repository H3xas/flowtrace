using System.Threading.Tasks;

namespace QuarryDispatch.Api.Services
{
    public interface IDispatchPlanRepository
    {
        Task SavePlan(string serial);
    }

    public class DispatchPlanRepository : IDispatchPlanRepository
    {
        public Task SavePlan(string serial)
        {
            return Task.CompletedTask;
        }
    }
}

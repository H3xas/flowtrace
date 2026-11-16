using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.DataAccess
{
    public interface IHarvestPlanRepository
    {
        void InsertPlan(HarvestPlan plan);
    }

    public class HarvestPlanRepository : IHarvestPlanRepository
    {
        public void InsertPlan(HarvestPlan plan)
        {
        }
    }
}

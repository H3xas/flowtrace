using Greenhouse.Alerts.DataAccess;
using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.Services
{
    public interface IHarvestPlanWriter
    {
        void SavePlan(HarvestPlan plan);
    }

    public class HarvestPlanWriter : IHarvestPlanWriter
    {
        private readonly IHarvestPlanRepository _plans;

        public HarvestPlanWriter(IHarvestPlanRepository plans)
        {
            _plans = plans;
        }

        public void SavePlan(HarvestPlan plan)
        {
            _plans.InsertPlan(plan);
        }
    }
}

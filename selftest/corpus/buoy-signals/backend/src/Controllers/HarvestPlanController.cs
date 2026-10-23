using Greenhouse.Alerts.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Greenhouse.Alerts.Controllers
{
    [ApiController]
    [Authorize]
    [Route("glasshouse/v1/zones")]
    public class HarvestPlanController : ControllerBase
    {
        private readonly IHarvestPlanner _planner;

        public HarvestPlanController(IHarvestPlanner planner)
        {
            _planner = planner;
        }

        [HttpPost("{zoneId}/harvest-plan")]
        public IActionResult CommitPlan(string zoneId)
        {
            var plan = _planner.CommitPlan(zoneId);
            return Ok(plan);
        }
    }
}

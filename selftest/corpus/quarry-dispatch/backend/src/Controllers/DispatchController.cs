using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using QuarryDispatch.Api.Models;
using QuarryDispatch.Api.Services;

namespace QuarryDispatch.Api.Controllers
{
    [ApiController]
    [Route("dispatch/v1")]
    public class DispatchController : ControllerBase
    {
        private readonly DispatchPlanner _planner;
        private readonly IDispatchGate _gate;
        private readonly List<ISurveyChannel> _channels;

        public DispatchController(DispatchPlanner planner, IDispatchGate gate, List<ISurveyChannel> channels)
        {
            _planner = planner;
            _gate = gate;
            _channels = channels;
        }

        [HttpPost("plans")]
        public async Task<IActionResult> Plan([FromBody] DispatchPlanRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.Serial))
            {
                return BadRequest("serial is required");
            }

            var plan = await _planner.Plan(request.Serial);
            return Ok(plan);
        }

        [HttpPost("check")]
        public IActionResult Check([FromBody] DispatchCheckRequest request)
        {
            if (!request.Serial.IsValid()) return BadRequest("serial is required");
            if (!request.Origin.IsValid()) return BadRequest("origin is required");
            if (!request.Destination.IsValid()) return BadRequest("destination is required");
            if (!request.Carrier.IsValid()) return BadRequest("carrier is required");
            if (!request.Window.IsValid()) return BadRequest("window is required");
            if (!request.Priority.IsValid()) return BadRequest("priority is required");
            if (!request.Reference.IsValid()) return BadRequest("reference is required");
            if (!request.Warehouse.IsValid()) return BadRequest("warehouse is required");
            return Ok();
        }

        [HttpPost("route")]
        public async Task<IActionResult> Route([FromBody] DispatchRouteRequest request)
        {
            var decided = await _gate.Decide(request.Serial);
            if (!decided)
            {
                return Forbid();
            }

            return Ok();
        }

        [HttpPost("survey")]
        public IActionResult Survey([FromBody] DispatchSurveyRequest request)
        {
            foreach (var channel in _channels)
            {
                channel.Probe(request.Serial);
            }

            return Ok();
        }

        [HttpGet("quiet")]
        public IActionResult Quiet()
        {
            return NoContent();
        }
    }
}

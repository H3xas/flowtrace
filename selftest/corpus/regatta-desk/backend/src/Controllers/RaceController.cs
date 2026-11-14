using Microsoft.AspNetCore.Mvc;

namespace Regatta.Api.Controllers
{
    [ApiController]
    [Route("race/v1")]
    public class RaceController : ControllerBase
    {
        [HttpGet("today")]
        public IActionResult Today()
        {
            return Ok();
        }

        [HttpPost("checkin")]
        public IActionResult Checkin()
        {
            return Ok();
        }

        [HttpGet("marks")]
        public IActionResult Marks()
        {
            return Ok();
        }

        [HttpGet("briefing")]
        public IActionResult Briefing()
        {
            return Ok();
        }

        [HttpGet("rules")]
        public IActionResult Rules()
        {
            return Ok();
        }

        [HttpPost("protest")]
        public IActionResult Protest()
        {
            return Ok();
        }
    }
}

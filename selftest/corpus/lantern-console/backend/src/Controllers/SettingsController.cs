using Microsoft.AspNetCore.Mvc;

namespace LanternConsole.Api.Controllers
{
    [ApiController]
    [Route("lanterns/v1")]
    public class SettingsController : ControllerBase
    {
        [HttpGet("settings")]
        public IActionResult GetSettings()
        {
            return Ok();
        }

        [HttpGet("audit")]
        public IActionResult GetAudit()
        {
            return Ok();
        }
    }
}

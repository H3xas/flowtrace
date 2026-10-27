using Microsoft.AspNetCore.Mvc;

namespace Kite.Api.Controllers
{
    [ApiController]
    [Route("clubs/v1")]
    public class StatusController : ControllerBase
    {
        [HttpGet("health")]
        public IActionResult Health()
        {
            return Ok();
        }
    }
}

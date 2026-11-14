using Microsoft.AspNetCore.Mvc;

namespace WidgetGate.Api.Controllers
{
    [ApiController]
    [Route("gate/v1")]
    public class GateController : ControllerBase
    {
        [HttpGet("open")]
        public IActionResult Open() => Ok();

        [HttpGet("staged")]
        public IActionResult Staged() => Ok();

        [HttpGet("unread")]
        public IActionResult Unread() => Ok();

        [HttpGet("parked")]
        public IActionResult Parked() => Ok();

        [HttpGet("folded")]
        public IActionResult Folded() => Ok();

        [HttpGet("grouped")]
        public IActionResult Grouped() => Ok();

        [HttpGet("wrapped")]
        public IActionResult Wrapped() => Ok();
    }
}

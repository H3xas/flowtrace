using Microsoft.AspNetCore.Mvc;

namespace ReefLedger.Api.Controllers
{
    [ApiController]
    [Route("reef/v1/sites")]
    public class SiteController : ControllerBase
    {
        [HttpGet]
        public IActionResult ListSites()
        {
            return Ok();
        }

        [HttpGet("{siteId}/tides")]
        public IActionResult GetTides(string siteId)
        {
            return Ok();
        }

        [HttpPost("visits")]
        public IActionResult LogVisit()
        {
            return Accepted();
        }

        [HttpGet("closures")]
        public IActionResult ListClosures()
        {
            return Ok();
        }
    }
}
